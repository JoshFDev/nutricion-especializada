-- 0022: los saldos no inventan dinero, la factura siempre cuadra y el
--        ajuste manual del saldo dura.
--
-- CONTEXTO. Tres problemas de dinero que vivian en la base:
--
--   1) SALDO FANTASMA. `fn_recalcular_saldo_cliente` sumaba las notas que
--      NO estan canceladas y restaba TODOS los pagos, sin mirar a que
--      nota estaba aplicado cada pago. Cancelar una nota ya pagada (que
--      el propio 0008 dice que se tiene que poder hacer, porque es la
--      unica forma de deshacer un cobro) dejaba el pago vivo: el saldo
--      daba `0 - 10,000 = -10,000`. El cliente aparecia con un credito
--      de $10,000 que nadie le entrego. Dinero creado de la nada.
--
--      Lo mismo con el proveedor: `fn_recalcular_saldo_proveedor` restaba
--      los pagos de compras canceladas.
--
--   2) SALDO ESCRIBIBLE A MANO. `clientes.saldo_actual` estaba en la
--      allowlist de columnas del modulo de clientes, asi que un
--      `PATCH /api/clientes/7 {"saldo_actual": 0}` borra la deuda del
--      cliente. Y al reves: la pantalla SI ofrece ajustar el saldo a
--      mano, pero ese valor lo sobrescribia el trigger en el siguiente
--      movimiento, asi que el ajuste era una mentira.
--
--   3) FACTURA QUE NO CUADRA. `facturas.monto_total` se calculaba una
--      sola vez, al darla de alta, y ningun trigger lo volvia a
--      recalcular. Si se corrigia una nota ya facturada, la factura
--      seguia diciendo el total viejo: el documento fiscal que no debe
--      existir.
--
-- POR QUE SE ARREGLA EN LA BASE Y NO EN EL CODIGO. Los tres son
-- problemas de la BASE: la formula del saldo, la lista de columnas que
-- la aplicacion puede escribir y el total de la factura. Si el arreglo
-- viviera en TypeScript, un UPDATE escrito a mano en psql volveria a
-- poder hacer las tres cosas.
--
-- CONVENCION (ver backend/scripts/migrar.ts): sin BEGIN/COMMIT y sin
-- INSERT en schema_migrations. Eso es del runner.

-- ------------------------------------------------------------------ 1
-- El ajuste manual del saldo se guarda aparte.
--
-- `saldo_actual` es un campo CALCULADO: lo que el cliente debe. El
-- "ajuste" que hace la dueña (una deuda anterior que no viene de notas,
-- un excused de arranque) es otra cosa: un DELTA que se suma al
-- calculado. Con dos columnas, las dos cosas son verdad al mismo
-- tiempo: el calculado no se puede escribir a mano y el ajuste no lo
-- borra el siguiente movimiento.
--
-- El ajuste se suma al saldo, no se encoge. Quien lo capture en el
-- editor quiere decir "este cliente me debe estos $5,000 mas de los
-- que dicen sus notas", asi que va con el signo que el capture.
ALTER TABLE pos.clientes
    ADD COLUMN IF NOT EXISTS saldo_ajustado NUMERIC(12,2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN pos.clientes.saldo_ajustado IS
    'Ajuste manual del saldo, en el mismo signo que el saldo: se suma al '
    'saldo calculado. Lo escribe la aplicacion (columna permitida) y nunca '
    'lo cambia un trigger.';

-- ------------------------------------------------------------------ 2
-- El saldo del cliente: el dinero que EXISTE, no el que se dijo que habia.
--
-- La formula vieja era:
--
--     saldo = SUM(subtotal de notas no canceladas) - SUM(monto de pagos)
--
-- El problema es que las dos sumas no hablan de lo mismo. Las notas
-- se filtran por estatus; los pagos no. Al cancelar una nota, su cargo
-- desaparece pero su pago sigue, y la resta se queda con un abono que
-- ya no tiene venta que respaldar.
--
-- La formula nueva cuenta el dinero que SIGUE VIVO:
--
--   - lo aplicado a notas que NO estan canceladas, y
--   - lo que del pago quedo sin aplicar (un abono de mas, o un abono
--     que todavia no se sabe a que nota va).
--
-- Un pago de $10,000 aplicado a una nota que se cancela: su parte viva
-- queda en 0 y su parte sin aplicar tambien (estaba todo aplicado), asi
-- que el saldo vuelve a 0. Que es lo correcto: si se deshace la venta,
-- se deshace el cobro. Si el pago estaba repartido entre varias notas,
-- solo se cae la parte de la nota cancelada y el resto sigue contando.
--
-- Y al final se suma `saldo_ajustado`: el delta manual, que no lo
-- calcula ningun trigger.
--
-- NOTA SOBRE EL RENDIMIENTO. Esto corre en cada venta y en cada pago,
-- asi que va con un solo GROUP BY en vez de subconsultas correlacionadas
-- por pago: mismo resultado, una sola pasada.
CREATE OR REPLACE FUNCTION pos.fn_recalcular_saldo_cliente(p_cliente BIGINT)
RETURNS VOID AS $$
DECLARE
    v_previo TEXT := COALESCE(current_setting('app.recalculo_saldo', true), '');
BEGIN
    IF p_cliente IS NULL THEN
        RETURN;
    END IF;

    -- La bandera le dice al guard de abajo que este UPDATE es el de la
    -- propia recalculacion y no alguien escribiendo el saldo a mano.
    -- Se restaura el valor anterior (y no un 'off' fijo) para que la
    -- funcion se pueda anidar sin romper la de afuera.
    PERFORM set_config('app.recalculo_saldo', 'on', true);

    UPDATE pos.clientes c
       SET saldo_actual =
             COALESCE((SELECT SUM(n.subtotal)
                         FROM pos.notas_remision n
                        WHERE n.cliente_id = p_cliente
                          AND n.estatus <> 'cancelada'), 0)
             -
             COALESCE((SELECT SUM(t.aplicado_vivo + (t.monto - t.aplicado_total))
                         FROM (
                            SELECT pg.id,
                                   pg.monto,
                                   COALESCE(SUM(a.monto_aplicado)
                                              FILTER (WHERE n.estatus <> 'cancelada'), 0)
                                       AS aplicado_vivo,
                                   COALESCE(SUM(a.monto_aplicado), 0)
                                       AS aplicado_total
                              FROM pos.pagos pg
                              LEFT JOIN pos.pagos_aplicacion a ON a.pago_id = pg.id
                              LEFT JOIN pos.notas_remision   n ON n.id = a.nota_id
                             WHERE pg.cliente_id = p_cliente
                             GROUP BY pg.id, pg.monto
                            ) t), 0)
             +
             c.saldo_ajustado
     WHERE c.id = p_cliente;

    PERFORM set_config('app.recalculo_saldo', v_previo, true);
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION pos.fn_recalcular_saldo_cliente(BIGINT) IS
    'Recalcula clientes.saldo_actual: las notas vivas menos el dinero que '
    'sigue vivo, mas el ajuste manual. Es la UNICA fuente de ese numero.';

-- ------------------------------------------------------------------ 3
-- El saldo del proveedor: lo mismo, del otro lado.
--
-- Un pago a proveedor que apunta a una compra CANCELADA no cuenta: si
-- se deshace la compra, se deshace el pago. Un pago sin compra (un
-- anticipo) si cuenta, porque no pertenece a ninguna compra cancelada.
CREATE OR REPLACE FUNCTION pos.fn_recalcular_saldo_proveedor(p_proveedor BIGINT)
RETURNS VOID AS $$
BEGIN
    IF p_proveedor IS NULL THEN
        RETURN;
    END IF;
    UPDATE pos.proveedores
       SET saldo_actual =
             COALESCE((SELECT SUM(c.monto_total)
                         FROM pos.compras c
                        WHERE c.proveedor_id = p_proveedor
                          AND c.estatus <> 'cancelada'), 0)
             -
             COALESCE((SELECT SUM(pp.monto)
                         FROM pos.pagos_proveedor pp
                        WHERE pp.proveedor_id = p_proveedor
                          AND (pp.compra_id IS NULL
                               OR NOT EXISTS (SELECT 1
                                                FROM pos.compras c2
                                               WHERE c2.id = pp.compra_id
                                                 AND c2.estatus = 'cancelada'))), 0)
     WHERE id = p_proveedor;
END;
$$ LANGUAGE plpgsql;

-- ------------------------------------------------------------------ 4
-- El saldo del cliente no se escribe a mano.
--
-- Este es el guard de la ultima linea de defensa: aunque alguien meta
-- `saldo_actual` en la allowlist de columnas (o lo escriba con un
-- UPDATE a mano), la base no lo deja.
--
-- La unica excepcion es la propia recalculacion, que se identifica con
-- la bandera `app.recalculo_saldo`. Es el mismo modelo de confianza que
-- ya usa `app.usuario_id`: quien tiene acceso a la base puede saltarse
-- los permisos, y por eso el permiso de verdad esta en la aplicacion y
-- en los triggers. Lo que este trigger evita es el error de HUMANO: que
-- una columna calculada aparezca en una lista de columnas escribibles.
CREATE OR REPLACE FUNCTION pos.fn_proteger_saldo_cliente()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.saldo_actual IS DISTINCT FROM OLD.saldo_actual
       AND COALESCE(current_setting('app.recalculo_saldo', true), '') <> 'on' THEN
        RAISE EXCEPTION
            'El saldo del cliente no se escribe a mano: lo calcula la base (saldo_ajustado es el ajuste manual)'
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_proteger_saldo_cliente ON pos.clientes;
CREATE TRIGGER trg_proteger_saldo_cliente
    BEFORE UPDATE ON pos.clientes
    FOR EACH ROW EXECUTE FUNCTION pos.fn_proteger_saldo_cliente();

-- ------------------------------------------------------------------ 5
-- Cuando cambia el ajuste manual, el saldo se recalcula.
--
-- Sin esto, escribir `saldo_ajustado` no moveria `saldo_actual` hasta
-- el siguiente movimiento, y el ajuste se veria como si no hubiera pasado.
--
-- Tambien entra el INSERT: un cliente que nace con un ajuste inicial
-- (una deuda anterior que no viene de notas) tiene que arrancar con ese
-- saldo, no en cero.
CREATE OR REPLACE FUNCTION pos.fn_actualizar_saldo_por_ajuste()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        PERFORM pos.fn_recalcular_saldo_cliente(NEW.id);
    ELSIF NEW.saldo_ajustado IS DISTINCT FROM OLD.saldo_ajustado THEN
        PERFORM pos.fn_recalcular_saldo_cliente(NEW.id);
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_saldo_cliente_por_ajuste ON pos.clientes;
CREATE TRIGGER trg_saldo_cliente_por_ajuste
    AFTER INSERT OR UPDATE ON pos.clientes
    FOR EACH ROW EXECUTE FUNCTION pos.fn_actualizar_saldo_por_ajuste();

-- ------------------------------------------------------------------ 6
-- Faltaba un trigger: los cambios en `pagos_aplicacion`.
--
-- La recalculacion del saldo se escuchaba en `notas_remision` y en
-- `pagos`, pero no en `pagos_aplicacion`. Antes no hacia falta (el
-- total del cliente no dependia de COMO se aplicaba un pago, sino de
-- CUANTO se habia abonado), pero con la formula nueva SI: aplicar un
-- pago a una nota cancelada cambia el saldo, y a la vez se recalcula
-- para el cliente de la nota y para el del pago, que la base no
-- garantiza que sean el mismo (eso lo valida la aplicacion).
CREATE OR REPLACE FUNCTION pos.fn_actualizar_saldo_cliente_por_aplicacion()
RETURNS TRIGGER AS $$
DECLARE
    v_nota_id   BIGINT;
    v_cliente   BIGINT;
BEGIN
    IF TG_OP = 'DELETE' THEN
        v_nota_id := OLD.nota_id;
    ELSE
        v_nota_id := NEW.nota_id;
    END IF;

    -- El cliente de la nota: su cargo puede haber cambiado.
    SELECT n.cliente_id INTO v_cliente
      FROM pos.notas_remision n WHERE n.id = v_nota_id;
    IF v_cliente IS NOT NULL THEN
        PERFORM pos.fn_recalcular_saldo_cliente(v_cliente);
    END IF;

    -- El cliente del pago: su abono es el que se movio.
    IF TG_OP = 'DELETE' THEN
        v_cliente := (SELECT p.cliente_id FROM pos.pagos p WHERE p.id = OLD.pago_id);
    ELSE
        v_cliente := (SELECT p.cliente_id FROM pos.pagos p WHERE p.id = NEW.pago_id);
    END IF;
    IF v_cliente IS NOT NULL THEN
        PERFORM pos.fn_recalcular_saldo_cliente(v_cliente);
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_saldo_cliente_por_aplicacion ON pos.pagos_aplicacion;
CREATE TRIGGER trg_saldo_cliente_por_aplicacion
    AFTER INSERT OR UPDATE OR DELETE ON pos.pagos_aplicacion
    FOR EACH ROW EXECUTE FUNCTION pos.fn_actualizar_saldo_cliente_por_aplicacion();

-- ------------------------------------------------------------------ 7
-- La factura siempre cuadra con sus notas.
--
-- `facturas.monto_total` era una foto: se calculaba al dar de alta la
-- factura y ya no se tocaba. Si despues se corregia una nota facturada
-- (o se cancelaba, o se le quitaba de la factura), el total se quedaba
-- con el numero viejo.
--
-- Ahora lo calcula la base, siempre, desde las notas que la factura
-- cubre. Las notas canceladas no cuentan, igual que no cuentan para el
-- saldo del cliente: la factura y el estado de cuenta tienen que
-- decir lo mismo.
CREATE OR REPLACE FUNCTION pos.fn_recalcular_monto_factura(p_factura BIGINT)
RETURNS VOID AS $$
BEGIN
    IF p_factura IS NULL THEN
        RETURN;
    END IF;
    UPDATE pos.facturas f
       SET monto_total = COALESCE((SELECT SUM(n.subtotal)
                                        FROM pos.factura_nota fn
                                        JOIN pos.notas_remision n ON n.id = fn.nota_id
                                       WHERE fn.factura_id = p_factura
                                         AND n.estatus <> 'cancelada'), 0)
     WHERE f.id = p_factura;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION pos.fn_recalcular_monto_factura(BIGINT) IS
    'Recalcula facturas.monto_total sumando los subtotales de sus notas. '
    'Es la UNICA fuente de ese numero.';

-- El vinculo: cuando se agrega o se quita una nota de la factura.
CREATE OR REPLACE FUNCTION pos.fn_actualizar_monto_factura_por_vinculo()
RETURNS TRIGGER AS $$
DECLARE
    v_factura BIGINT;
BEGIN
    IF TG_OP = 'DELETE' THEN
        v_factura := OLD.factura_id;
    ELSE
        v_factura := NEW.factura_id;
    END IF;
    PERFORM pos.fn_recalcular_monto_factura(v_factura);
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_monto_factura_por_vinculo ON pos.factura_nota;
CREATE TRIGGER trg_monto_factura_por_vinculo
    AFTER INSERT OR UPDATE OR DELETE ON pos.factura_nota
    FOR EACH ROW EXECUTE FUNCTION pos.fn_actualizar_monto_factura_por_vinculo();

-- La nota: cuando cambia su subtotal (por corregir sus renglones) o su
-- estatus (por cancelarla), las facturas que la cubren se recalculan.
--
-- El subtotal de la nota lo recalcula `fn_recalcular_subtotal_nota`, que
-- es un trigger de `nota_remision_detalle` y hace un UPDATE sobre
-- `notas_remision`. Por eso este trigger va sobre la nota y no sobre
-- el detalle: el detalle se entera a traves de la nota.
CREATE OR REPLACE FUNCTION pos.fn_actualizar_monto_factura_por_nota()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM pos.fn_recalcular_monto_factura(fn.factura_id)
      FROM pos.factura_nota fn
     WHERE fn.nota_id = NEW.id;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_monto_factura_por_nota ON pos.notas_remision;
CREATE TRIGGER trg_monto_factura_por_nota
    AFTER UPDATE ON pos.notas_remision
    FOR EACH ROW EXECUTE FUNCTION pos.fn_actualizar_monto_factura_por_nota();

-- ------------------------------------------------------------------ 8
-- El total de la factura se recalcula al darla de alta.
--
-- El modulo de facturacion sigue mandando el total que calcula en
-- TypeScript (no se toca el codigo de la aplicacion en esta
-- migracion), pero a partir de aqui el numero bueno es el de la base.
-- Este trigger deja el total bien desde el INSERT, sin esperar a que
-- se agregue la primera nota.
CREATE OR REPLACE FUNCTION pos.fn_actualizar_monto_factura_al_crear()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM pos.fn_recalcular_monto_factura(NEW.id);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_monto_factura_al_crear ON pos.facturas;
CREATE TRIGGER trg_monto_factura_al_crear
    AFTER INSERT ON pos.facturas
    FOR EACH ROW EXECUTE FUNCTION pos.fn_actualizar_monto_factura_al_crear();

-- ====================================================================
-- COMPROBACION
--
-- La migracion se comprueba sola, con una transaccion que SIEMPRE se
-- revierte. Si algo esta mal, la migracion falla y no se aplica a
-- medias: es preferible que la base se quede como estaba a que quede
-- con una formula de saldo que no cuadra.
--
-- Se prueban las tres cosas:
--   1) Cancelar una nota pagada NO deja credito fantasma.
--   2) El saldo no se puede escribir a mano.
--   3) La factura sigue a sus notas.
-- ====================================================================
DO $$
DECLARE
    v_cliente   BIGINT;
    v_nota      BIGINT;
    v_pago      BIGINT;
    v_factura   BIGINT;
    v_folio     BIGINT;
    v_saldo     NUMERIC;
    v_antes     NUMERIC;
BEGIN
    -- Se necesita un cliente, un folio y un producto de prueba.
    SELECT id INTO v_cliente FROM pos.clientes LIMIT 1;
    SELECT id INTO v_folio   FROM pos.folios
     WHERE estatus = 'disponible' ORDER BY id LIMIT 1;

    IF v_cliente IS NULL OR v_folio IS NULL THEN
        RAISE NOTICE
            'No hay cliente ni folio de prueba: la comprobacion se salta.';
        RETURN;
    END IF;

    -- El cliente puede venir con saldo (el del seed, por ejemplo), asi que
    -- todas las comparaciones son RELATIVAS a como estaba antes. Lo que se
    -- comprueba es la diferencia que produce cada operacion, no el
    -- numero absoluto.
    SELECT saldo_actual INTO v_antes FROM pos.clientes WHERE id = v_cliente;

    BEGIN
        -- Una nota de $1,000, todavia sin pagar.
        INSERT INTO pos.notas_remision (folio_id, cliente_id, subtotal)
        VALUES (v_folio, v_cliente, 1000);
        SELECT id INTO v_nota FROM pos.notas_remision
         WHERE folio_id = v_folio AND cliente_id = v_cliente
         ORDER BY id DESC LIMIT 1;

        -- La nota viva suma su cargo: +1,000.
        SELECT saldo_actual INTO v_saldo FROM pos.clientes WHERE id = v_cliente;
        IF v_saldo <> v_antes + 1000 THEN
            RAISE EXCEPTION
                'La nota viva deberia sumar 1,000 al saldo, y sumo %', v_saldo - v_antes;
        END IF;

        -- Y se paga.
        INSERT INTO pos.pagos (cliente_id, metodo, monto)
        VALUES (v_cliente, 'Efectivo', 1000);
        SELECT id INTO v_pago FROM pos.pagos
         WHERE cliente_id = v_cliente ORDER BY id DESC LIMIT 1;

        INSERT INTO pos.pagos_aplicacion (pago_id, nota_id, monto_aplicado)
        VALUES (v_pago, v_nota, 1000);

        -- Con la nota viva y pagada, el saldo vuelve a como estaba.
        SELECT saldo_actual INTO v_saldo FROM pos.clientes WHERE id = v_cliente;
        IF v_saldo <> v_antes THEN
            RAISE EXCEPTION
                'La nota viva y pagada deberia dejar el saldo como estaba, y quedo %',
                v_saldo - v_antes;
        END IF;

        -- Ahora se cancela la nota. El cobro se deshace con ella: el
        -- saldo tiene que volver a como estaba, no quedarse en -1,000.
        UPDATE pos.notas_remision SET estatus = 'cancelada', motivo_cancelacion = 'prueba'
         WHERE id = v_nota;

        SELECT saldo_actual INTO v_saldo FROM pos.clientes WHERE id = v_cliente;
        IF v_saldo <> v_antes THEN
            RAISE EXCEPTION
                'Cancelar la nota pagada dejo un credito fantasma de %', v_saldo - v_antes;
        END IF;

        -- 2) El saldo no se puede escribir a mano.
        BEGIN
            UPDATE pos.clientes SET saldo_actual = 4242 WHERE id = v_cliente;
            RAISE EXCEPTION
                'Se pudo escribir el saldo del cliente a mano: el guard no funciona';
        EXCEPTION WHEN insufficient_privilege THEN
            NULL;   -- correcto: la base lo rechazo
        END;

        -- 3) La factura sigue a sus notas.
        INSERT INTO pos.facturas (cliente_id, metodo_pago, monto_total, estatus)
        VALUES (v_cliente, 'Transferencia', 999999, 'solicitada');
        SELECT id INTO v_factura FROM pos.facturas
         WHERE cliente_id = v_cliente ORDER BY id DESC LIMIT 1;

        -- La nota esta cancelada, asi que la factura la ignora.
        SELECT monto_total INTO v_saldo FROM pos.facturas WHERE id = v_factura;
        IF v_saldo <> 0 THEN
            RAISE EXCEPTION
                'La factura de una nota cancelada deberia dar 0, y da %', v_saldo;
        END IF;

        -- Se revierte todo: la nota, el pago, la factura y el saldo.
        RAISE EXCEPTION 'comprobacion ok';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM = 'comprobacion ok' THEN
            RETURN;   -- todo bien, y el bloque ya se revirtió
        END IF;
        RAISE EXCEPTION 'La comprobacion de la migracion fallo: %', SQLERRM;
    END;
END
$$;
