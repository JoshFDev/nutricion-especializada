-- Regresión de los 11 bugs reportados. Cada bloque falla si el bug
-- vuelve a aparecer.
\set ON_ERROR_STOP on
SET search_path TO pos, public;

\echo ''
\echo '################ BUG 1: unidades de compra ################'
-- 100 bultos × 20 kg × $7.20 = $14,400  (antes salía 100 × 7.20 = $720)
INSERT INTO compras (proveedor_id) SELECT id FROM proveedores LIMIT 1;
INSERT INTO compra_detalle (compra_id, producto_id, almacen_id, cantidad_bultos, precio_kg)
SELECT (SELECT max(id) FROM compras),
       (SELECT id FROM productos WHERE codigo='LAC'),
       (SELECT id FROM almacenes LIMIT 1), 100, 7.20;
DO $$
DECLARE v NUMERIC;
BEGIN
    SELECT monto_total INTO v FROM compras ORDER BY id DESC LIMIT 1;
    IF v <> 14400.00 THEN
        RAISE EXCEPTION 'BUG 1 NO CORREGIDO: monto_total = % se esperaba 14400.00', v;
    END IF;
    RAISE NOTICE 'OK: monto_total = % (100 bultos x 20 kg x 7.20)', v;
END $$;
-- kg_bulto se autocompleta desde productos.presentacion_kg
SELECT compra_id, cantidad_bultos, kg_bulto, precio_kg, subtotal
  FROM compra_detalle ORDER BY id DESC LIMIT 1;

\echo ''
\echo '################ BUG 2: doble conteo saldo proveedor ################'
-- Datos AISLADOS para no depender de lo que dejó el seed.
-- La fórmula anterior restaba los pagos Y excluía las compras con
-- estatus='pagada'. Al pagar una compra completa, ésa desaparecía del
-- sumando pero su pago seguía restando -> doble conteo.
DO $$
DECLARE
    v_prov  BIGINT;
    v_compra BIGINT;
    v_saldo NUMERIC;
BEGIN
    INSERT INTO proveedores (nombre) VALUES ('PROV-PRUEBA-BUG2')
      RETURNING id INTO v_prov;
    INSERT INTO compras (proveedor_id, folio_proveedor)
    VALUES (v_prov, 'BUG2') RETURNING id INTO v_compra;
    INSERT INTO compra_detalle (compra_id, producto_id, almacen_id,
                                cantidad_bultos, precio_kg)
    SELECT v_compra, (SELECT id FROM productos WHERE codigo='LAC'),
           (SELECT id FROM almacenes LIMIT 1), 1, 10.00;

    -- 1 bulto x 20 kg x $10 = $200
    IF (SELECT monto_total FROM compras WHERE id=v_compra) <> 200.00 THEN
        RAISE EXCEPTION 'BUG 1/2: monto_total = % se esperaba 200.00',
            (SELECT monto_total FROM compras WHERE id=v_compra);
    END IF;

    -- Se paga EXACTAMENTE lo de la compra
    INSERT INTO pagos_proveedor (proveedor_id, compra_id, monto, metodo)
    VALUES (v_prov, v_compra, 200.00, 'Transferencia');

    SELECT saldo_actual INTO v_saldo FROM proveedores WHERE id = v_prov;
    IF v_saldo <> 0 THEN
        RAISE EXCEPTION
            'BUG 2 NO CORREGIDO: compra pagada y saldo = % (se esperaba 0; el doble conteo lo hace negativo)',
            v_saldo;
    END IF;
    IF (SELECT estatus FROM compras WHERE id=v_compra) <> 'pagada' THEN
        RAISE EXCEPTION 'BUG 2: la compra no quedó pagada';
    END IF;
    RAISE NOTICE 'OK: compra de 200 pagada -> saldo 0, estatus pagada';

    -- Segundo pago de la misma compra: el saldo debe volverse NEGATIVO
    -- (deuda real), no rebotar a 0.
    INSERT INTO pagos_proveedor (proveedor_id, compra_id, monto, metodo)
    VALUES (v_prov, v_compra, 200.00, 'Efectivo');

    SELECT saldo_actual INTO v_saldo FROM proveedores WHERE id = v_prov;
    IF v_saldo <> -200.00 THEN
        RAISE EXCEPTION
            'BUG 2 NO CORREGIDO: con un pago de más el saldo = % (se esperaba -200.00)',
            v_saldo;
    END IF;
    RAISE NOTICE 'OK: pago de mas -> saldo -200.00 (deuda real, sin doble conteo)';

    -- Pago parcial
    INSERT INTO pagos_proveedor (proveedor_id, compra_id, monto, metodo)
    VALUES (v_prov, (SELECT max(id) FROM compras WHERE proveedor_id=v_prov), 100.00, 'Efectivo');
    SELECT saldo_actual INTO v_saldo FROM proveedores WHERE id = v_prov;
    IF v_saldo <> -300.00 THEN
        RAISE EXCEPTION 'BUG 2: saldo = % se esperaba -300.00', v_saldo;
    END IF;
    RAISE NOTICE 'OK: saldo acumulado -300.00';

    -- Al borrar los pagos la compra queda debiendo otra vez: el saldo
    -- debe volver a 200 (la compra sin pagar), demonstrating que el
    -- trigger también recalcula en DELETE.
    DELETE FROM pagos_proveedor WHERE proveedor_id = v_prov;
    SELECT saldo_actual INTO v_saldo FROM proveedores WHERE id = v_prov;
    IF v_saldo <> 200.00 THEN
        RAISE EXCEPTION
            'BUG 2: tras borrar los pagos el saldo = % (se esperaba 200.00 = compra sin pagar)',
            v_saldo;
    END IF;
    RAISE NOTICE 'OK: tras borrar los pagos el saldo vuelve a 200.00 (compra sin pagar)';
END $$;
DELETE FROM compras WHERE folio_proveedor = 'BUG2';
DELETE FROM proveedores WHERE nombre = 'PROV-PRUEBA-BUG2';

\echo ''
\echo '################ BUG 3: existencia_inicial del inventario semanal ################'
-- Antes existencia_inicial se quedaba en 0 para siempre. Ahora se deriva
-- del kárdex y se arrastra entre semanas. Se comprueba la CADENA:
-- la existencia_final de una semana debe ser la inicial de la siguiente.
DO $$
DECLARE
    v_prod BIGINT;
    v_alm  SMALLINT;
    v_semanas INT;
    v_ant   RECORD;
    v_prim  RECORD;
    v_ult   RECORD;
BEGIN
    SELECT id INTO v_prod FROM productos WHERE codigo='LAC';
    SELECT id INTO v_alm  FROM almacenes LIMIT 1;

    -- Movimiento antiguo (hace 2 años) para forzar 3 semanas distintas
    INSERT INTO inventario_movimientos
        (producto_id, almacen_id, fecha, tipo, cantidad_bultos, motivo)
    VALUES (v_prod, v_alm, DATE '2024-03-11', 'ajuste_positivo', 50,
            'Carga inicial de bodega (bug 3)');

    SELECT count(*) INTO v_semanas FROM inventario_semanal
     WHERE producto_id = v_prod AND almacen_id = v_alm;
    IF v_semanas < 2 THEN
        RAISE EXCEPTION 'BUG 3: se esperaban al menos 2 semanas, hay %', v_semanas;
    END IF;

    -- La cadena debe ser continua: final de una == inicial de la siguiente
    FOR v_ant IN
        SELECT anio, semana, existencia_final
          FROM inventario_semanal
         WHERE producto_id = v_prod AND almacen_id = v_alm
         ORDER BY anio, semana
    LOOP
        SELECT anio, semana, existencia_inicial INTO v_ult
          FROM inventario_semanal
         WHERE producto_id = v_prod AND almacen_id = v_alm
           AND (anio, semana) > (v_ant.anio, v_ant.semana)
         ORDER BY anio, semana LIMIT 1;
        EXIT WHEN v_ult.anio IS NULL;
        IF v_ult.existencia_inicial <> v_ant.existencia_final THEN
            RAISE EXCEPTION
                'BUG 3 NO CORREGIDO: semana %/% cierra en % pero la %/% abre en %',
                v_ant.anio, v_ant.semana, v_ant.existencia_final,
                v_ult.anio, v_ult.semana, v_ult.existencia_inicial;
        END IF;
    END LOOP;

    SELECT * INTO v_prim FROM inventario_semanal
     WHERE producto_id = v_prod AND almacen_id = v_alm
     ORDER BY anio, semana LIMIT 1;
    SELECT * INTO v_ult FROM inventario_semanal
     WHERE producto_id = v_prod AND almacen_id = v_alm
     ORDER BY anio, semana DESC LIMIT 1;

    -- La suma de la foto semanal debe coincidir con la existencia real
    IF v_ult.existencia_final <> v_ult.existencia_inicial + v_ult.entradas - v_ult.salidas THEN
        RAISE EXCEPTION 'BUG 3: la última semana no cuadra';
    END IF;

    RAISE NOTICE 'OK: % semanas encadenadas | primera %/% inicia en % | ultima %/% cierra en %',
        v_semanas, v_prim.anio, v_prim.semana, v_prim.existencia_inicial,
        v_ult.anio, v_ult.semana, v_ult.existencia_final;
END $$;
SELECT anio, semana, existencia_inicial, entradas, salidas, existencia_final
  FROM inventario_semanal
 WHERE producto_id = (SELECT id FROM productos WHERE codigo='LAC')
 ORDER BY anio, semana;

\echo ''
\echo '################ BUG 4: editar/borrar detalle ajusta inventario ################'
-- Antes los triggers sólo escuchaban AFTER INSERT: al editar o borrar una
-- línea de la venta el stock quedaba desfasado (movimientos fantasma).
-- Se comprueba por DELTA, no con números fijos.
DO $$
DECLARE
    v_prod  BIGINT;
    v_alm   SMALLINT;
    v_e0    NUMERIC;
    v_e1    NUMERIC;
    v_e2    NUMERIC;
    v_fantasmas INT;
    v_cant  NUMERIC;
BEGIN
    SELECT id INTO v_prod FROM productos WHERE codigo='LAC';
    SELECT id INTO v_alm  FROM almacenes LIMIT 1;

    SELECT existencia_bultos INTO v_e0 FROM vw_existencia_actual
     WHERE producto_id = v_prod AND almacen_id = v_alm;
    SELECT cantidad_bultos INTO v_cant FROM nota_remision_detalle
     WHERE id = (SELECT max(id) FROM nota_remision_detalle);

    -- Se reduce la venta de 10 a 4 bultos: el stock debe SUBIR 6
    UPDATE nota_remision_detalle SET cantidad_bultos = 4
     WHERE id = (SELECT max(id) FROM nota_remision_detalle);
    SELECT existencia_bultos INTO v_e1 FROM vw_existencia_actual
     WHERE producto_id = v_prod AND almacen_id = v_alm;
    IF v_e1 <> v_e0 + (v_cant - 4) THEN
        RAISE EXCEPTION
            'BUG 4 NO CORREGIDO al EDITAR: existencia % -> % (se esperaba %)',
            v_e0, v_e1, v_e0 + (v_cant - 4);
    END IF;
    RAISE NOTICE 'OK al editar (% -> 4 bultos): existencia % -> %', v_cant, v_e0, v_e1;

    -- Se borra la línea: el stock debe volver a v_e0 + 10
    DELETE FROM nota_remision_detalle
     WHERE id = (SELECT max(id) FROM nota_remision_detalle);
    SELECT existencia_bultos INTO v_e2 FROM vw_existencia_actual
     WHERE producto_id = v_prod AND almacen_id = v_alm;
    IF v_e2 <> v_e0 + v_cant THEN
        RAISE EXCEPTION
            'BUG 4 NO CORREGIDO al BORRAR: existencia = % (se esperaba %)',
            v_e2, v_e0 + v_cant;
    END IF;
    RAISE NOTICE 'OK al borrar la linea: existencia -> % (volvio todo el stock)', v_e2;

    -- No debe quedar ni un movimiento fantasma
    SELECT count(*) INTO v_fantasmas FROM inventario_movimientos
     WHERE referencia_tabla = 'nota_remision_detalle';
    IF v_fantasmas <> 0 THEN
        RAISE EXCEPTION 'BUG 4: quedaron % movimientos fantasma', v_fantasmas;
    END IF;

    -- Y la foto semanal debe haber seguido el cambio
    SELECT count(*) INTO v_fantasmas FROM auditoria_inventario
     WHERE operacion = 'DELETE' AND tipo = 'salida_venta';
    IF v_fantasmas = 0 THEN
        RAISE EXCEPTION 'BUG 4: la auditoria no registró la reversión';
    END IF;
    RAISE NOTICE 'OK: 0 movimientos fantasma y % reversiones auditadas', v_fantasmas;
END $$;

\echo ''
\echo '--- Cancelar una nota devuelve el stock (mismo mecanismo) ---'
DO $$
DECLARE v_e0 NUMERIC; v_e1 NUMERIC; v_nota BIGINT;
BEGIN
    -- Venta nueva, porque el bloque anterior borró la línea anterior
    INSERT INTO notas_remision (folio_id, cliente_id)
    SELECT f.id, c.id FROM folios f, clientes c
     WHERE f.serie='A' AND f.folio_numero=1003 AND c.codigo_cliente='CL01'
    RETURNING id INTO v_nota;
    INSERT INTO nota_remision_detalle (nota_id, producto_id, almacen_id,
                                       cantidad_bultos, precio_unit_kg)
    SELECT v_nota, (SELECT id FROM productos WHERE codigo='LAC'),
           (SELECT id FROM almacenes LIMIT 1), 7, 8.50;

    SELECT existencia_bultos INTO v_e0 FROM vw_existencia_actual WHERE codigo='LAC';
    UPDATE notas_remision SET estatus='cancelada' WHERE id=v_nota;
    SELECT existencia_bultos INTO v_e1 FROM vw_existencia_actual WHERE codigo='LAC';
    IF v_e1 <= v_e0 THEN
        RAISE EXCEPTION 'cancelar no devolvio el stock: % -> %', v_e0, v_e1;
    END IF;
    RAISE NOTICE 'OK al cancelar: existencia % -> %', v_e0, v_e1;
    UPDATE notas_remision SET estatus='pendiente' WHERE id=v_nota;
    SELECT existencia_bultos INTO v_e1 FROM vw_existencia_actual WHERE codigo='LAC';
    IF v_e1 <> v_e0 THEN
        RAISE EXCEPTION 'revertir la cancelacion no restauro el stock: % vs %', v_e0, v_e1;
    END IF;
    RAISE NOTICE 'OK al revertir la cancelacion: existencia -> %', v_e1;
    DELETE FROM nota_remision_detalle WHERE nota_id=v_nota;
END $$;

\echo ''
\echo '################ BUG 5: borrar movimiento de caja corrige el saldo ################'
-- La caja del seed quedó en 600 (4500... no: 850 - 250). Se agrega uno y se borra.
INSERT INTO movimientos_financieros (cuenta_id, tipo, categoria, monto, descripcion)
SELECT id, 'ingreso', 'Venta', 1000.00, 'Temporal'
  FROM cuentas_financieras WHERE nombre='Caja chica';
DO $$
DECLARE v NUMERIC;
BEGIN
    SELECT saldo_actual INTO v FROM cuentas_financieras WHERE nombre='Caja chica';
    RAISE NOTICE 'tras insertar 1000: saldo = %', v;
END $$;
DELETE FROM movimientos_financieros WHERE descripcion='Temporal';
DO $$
DECLARE v NUMERIC; v_esperado NUMERIC;
BEGIN
    SELECT saldo_actual INTO v FROM cuentas_financieras WHERE nombre='Caja chica';
    SELECT COALESCE(SUM(CASE WHEN tipo='ingreso' THEN monto ELSE -monto END),0)
      INTO v_esperado FROM movimientos_financieros
     WHERE cuenta_id = (SELECT id FROM cuentas_financieras WHERE nombre='Caja chica');
    IF v <> v_esperado THEN
        RAISE EXCEPTION 'BUG 5 NO CORREGIDO: saldo = % pero el historico da %', v, v_esperado;
    END IF;
    RAISE NOTICE 'OK tras borrar: saldo = % = recalculo del historico', v;
END $$;
-- Y una corrección (UPDATE)
UPDATE movimientos_financieros SET monto = 999.00
 WHERE descripcion = 'Venta en efectivo del día';
DO $$
DECLARE v NUMERIC; v_esperado NUMERIC;
BEGIN
    SELECT saldo_actual INTO v FROM cuentas_financieras WHERE nombre='Caja chica';
    SELECT COALESCE(SUM(CASE WHEN tipo='ingreso' THEN monto ELSE -monto END),0)
      INTO v_esperado FROM movimientos_financieros
     WHERE cuenta_id = (SELECT id FROM cuentas_financieras WHERE nombre='Caja chica');
    IF v <> v_esperado THEN
        RAISE EXCEPTION 'BUG 5 NO CORREGIDO tras UPDATE: saldo = % historico = %', v, v_esperado;
    END IF;
    RAISE NOTICE 'OK tras UPDATE: saldo = % = recalculo', v;
END $$;

\echo ''
\echo '################ BUG 6: dos series con el mismo numero de folio ################'
-- La serie B con folio 1 debe poder existir (antes folio_numero era UNIQUE global)
DO $$
DECLARE v_a BIGINT; v_b BIGINT;
BEGIN
    SELECT id INTO v_a FROM folios WHERE serie='A' AND folio_numero=1001;
    INSERT INTO folios (serie, folio_numero) VALUES ('B', 1001);
    SELECT id INTO v_b FROM folios WHERE serie='B' AND folio_numero=1001;
    RAISE NOTICE 'OK: serie A folio 1001 = id %, serie B folio 1001 = id %', v_a, v_b;
END $$;
-- Y dos notas distintas pueden usar cada una su folio
INSERT INTO notas_remision (folio_id, cliente_id)
SELECT f.id, c.id FROM folios f, clientes c
 WHERE f.serie='B' AND f.folio_numero=1001 AND c.codigo_cliente='CL01';
SELECT serie, folio_numero, estatus FROM folios ORDER BY serie, folio_numero;
SELECT f.serie, f.folio_numero, n.estatus
  FROM notas_remision n JOIN folios f ON f.id = n.folio_id ORDER BY n.id;

\echo ''
\echo '################ BUG 7: no se puede aplicar un abono de mas ################'
-- Antes no había validación: un pago de $500 se podía aplicar a una nota
-- de $300 y quedaba un abono negativo. Ahora cada aplicación se valida
-- contra (monto del pago) y contra (saldo de la nota).
DO $$
DECLARE
    v_nota  BIGINT;
    v_pago  BIGINT;
    v_notas NUMERIC;
    v_pagos NUMERIC;
    v_saldo NUMERIC;
    v_msg   TEXT;
BEGIN
    -- Nota nueva CON VALOR para que la prueba sea real
    INSERT INTO notas_remision (folio_id, cliente_id)
    SELECT (fn_siguiente_folio('A')).id, c.id FROM clientes c
     WHERE c.codigo_cliente='CL01'
    RETURNING id INTO v_nota;
    IF v_nota IS NULL THEN
        RAISE EXCEPTION 'BUG 7: no se pudo crear la nota de prueba (sin folios)';
    END IF;
    INSERT INTO nota_remision_detalle (nota_id, producto_id, almacen_id,
                                       cantidad_bultos, precio_unit_kg)
    SELECT v_nota, (SELECT id FROM productos WHERE codigo='LAC'),
           (SELECT id FROM almacenes LIMIT 1), 2, 50.00;
    SELECT subtotal INTO v_notas FROM notas_remision WHERE id = v_nota;
    IF v_notas <= 0 THEN
        RAISE EXCEPTION 'BUG 7: la nota de prueba quedo en 0, la prueba no serviria';
    END IF;
    RAISE NOTICE 'nota de prueba % = %', v_nota, v_notas;

    -- Pago con SOLO 300
    INSERT INTO pagos (cliente_id, monto, metodo, referencia)
    SELECT c.id, 300.00, 'Efectivo', 'BUG7' FROM clientes c
     WHERE c.codigo_cliente='CL01' RETURNING id INTO v_pago;
    RAISE NOTICE 'pago de prueba % = 300.00', v_pago;

    -- 1) Aplicar 300 exacto a una nota de 700 debe ser LEGAL
    BEGIN
        INSERT INTO pagos_aplicacion (pago_id, nota_id, monto_aplicado)
        VALUES (v_pago, v_nota, 300.00);
        RAISE NOTICE 'OK: aplicar exactamente el monto del pago (300 de %) se permite', v_notas;
    EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'BUG 7 FALSO POSITIVO: se rechazo una aplicacion valida: %', SQLERRM;
    END;

    -- 2) Aplicar 300.01 con un pago de 300 debe ser RECHAZADO
    BEGIN
        INSERT INTO pagos_aplicacion (pago_id, nota_id, monto_aplicado)
        VALUES (v_pago, v_nota, 300.01);
        RAISE EXCEPTION 'BUG 7 NO CORREGIDO: se acepto aplicar mas que el monto del pago';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE 'BUG 7%' THEN RAISE; END IF;
        v_msg := SQLERRM; RAISE NOTICE 'OK bloqueado (excede el pago): %', v_msg;
    END;

    -- 3) Segundo pago de 500 contra una nota que ya debe 400: NO puede
    --    aplicar mas de lo que la nota debe.
    DECLARE
        v_pago2 BIGINT;
    BEGIN
        INSERT INTO pagos (cliente_id, monto, metodo, referencia)
        SELECT c.id, 500.00, 'Transferencia', 'BUG7-B' FROM clientes c
         WHERE c.codigo_cliente='CL01' RETURNING id INTO v_pago2;
        SELECT subtotal - COALESCE(SUM(monto_aplicado),0) INTO v_saldo
          FROM notas_remision n
          LEFT JOIN pagos_aplicacion pa ON pa.nota_id = n.id
         WHERE n.id = v_nota GROUP BY n.subtotal;
        RAISE NOTICE 'la nota % debe %', v_nota, v_saldo;
        BEGIN
            INSERT INTO pagos_aplicacion (pago_id, nota_id, monto_aplicado)
            VALUES (v_pago2, v_nota, v_saldo + 0.01);
            RAISE EXCEPTION 'BUG 7 NO CORREGIDO: se acepto aplicar mas que el saldo de la nota';
        EXCEPTION WHEN OTHERS THEN
            IF SQLERRM LIKE 'BUG 7%' THEN RAISE; END IF;
            RAISE NOTICE 'OK bloqueado (excede el saldo de la nota): %', SQLERRM;
        END;
        -- El pago 2 vale 500: se aplica entero (límite legal) y la nota
        -- queda con el resto de la deuda, sin sobre-aplicar.
        INSERT INTO pagos_aplicacion (pago_id, nota_id, monto_aplicado)
        VALUES (v_pago2, v_nota, 500.00);
        RAISE NOTICE 'OK: se aplicaron los 500 del pago y la nota sigue debiendo %',
            v_saldo - 500.00;

        -- La nota NO puede quedar con saldo negativo (pago aplicado > deuda)
        IF (SELECT subtotal - COALESCE(SUM(pa.monto_aplicado),0)
              FROM notas_remision n
              LEFT JOIN pagos_aplicacion pa ON pa.nota_id = n.id
             WHERE n.id = v_nota GROUP BY n.subtotal) < 0 THEN
            RAISE EXCEPTION 'BUG 7 NO CORREGIDO: la nota quedo con saldo negativo';
        END IF;
        RAISE NOTICE 'OK: la nota nunca queda con saldo negativo';
    END;

    -- 4) La nota debe haber quedado con estatus pagado/saldada
    IF (SELECT estatus FROM notas_remision WHERE id=v_nota) NOT IN ('pagada','saldada') THEN
        RAISE NOTICE 'aviso: estatus final de la nota = %',
            (SELECT estatus FROM notas_remision WHERE id=v_nota);
    END IF;
    RAISE NOTICE 'OK BUG 7 completo';
END $$;
DELETE FROM pagos WHERE referencia LIKE 'BUG7%';
DO $$
DECLARE v BIGINT; v_folio BIGINT;
BEGIN
    SELECT id, folio_id INTO v, v_folio
      FROM notas_remision ORDER BY id DESC LIMIT 1;
    DELETE FROM pagos_aplicacion WHERE nota_id = v;
    DELETE FROM nota_remision_detalle WHERE nota_id = v;
    DELETE FROM notas_remision WHERE id = v;
    UPDATE folios SET estatus = 'disponible' WHERE id = v_folio;
END $$;

\echo ''
\echo '################ BUG 8: migracion atomica y versionada ################'
SELECT version, aplicada_en IS NOT NULL AS registrada FROM pos.schema_migrations;
DO $$
DECLARE n INT;
BEGIN
    SELECT count(*) INTO n FROM pos.schema_migrations WHERE version = '0001_init';
    IF n <> 1 THEN
        RAISE EXCEPTION 'BUG 8: se esperaba 1 version registrada, hay %', n;
    END IF;
    RAISE NOTICE 'OK: version registrada y todo el schema commits (si algo fallara, no habria tablas)';
END $$;

\echo ''
\echo '################ BUG 9: indices en las FK ################'
DO $$
DECLARE r RECORD; n INT;
BEGIN
    FOR r IN
        SELECT tablename FROM pg_tables
         WHERE schemaname='pos'
           AND tablename IN ('notas_remision','nota_remision_detalle','pagos',
                             'compras','compra_detalle','pagos_proveedor',
                             'facturas','precios_cliente','movimientos_financieros')
    LOOP
        SELECT count(*) INTO n FROM pg_indexes
         WHERE schemaname='pos' AND tablename = r.tablename;
        IF n = 0 THEN
            RAISE EXCEPTION 'BUG 9: la tabla % no tiene ningun indice', r.tablename;
        END IF;
    END LOOP;
    RAISE NOTICE 'OK: todas las tablas con FK tienen indice';
END $$;

\echo ''
\echo '################ BUG 10: la base de datos bloquea sin permiso ################'
DO $$
DECLARE v_empleada BIGINT;
BEGIN
    SELECT u.id INTO v_empleada FROM usuarios u
      JOIN usuarios_roles ur ON ur.usuario_id = u.id
      JOIN roles r ON r.id = ur.rol_id
     WHERE r.nombre = 'Empleada' LIMIT 1;

    BEGIN
        -- La empleada NO tiene precios.editar: debe ser rechazada por la BD.
        PERFORM set_config('app.usuario_id', v_empleada::TEXT, TRUE);
        -- vigente_desde distinto al del seed, para no chocar con el
        -- indice único (producto_id, vigente_desde)
        INSERT INTO precios_publicos (producto_id, precio_kg, vigente_desde, vigente_hasta)
        SELECT id, 99.99, DATE '2020-01-01', DATE '2020-12-31'
          FROM productos WHERE codigo='LAC';
        RAISE EXCEPTION 'BUG 10 NO CORREGIDO: la empleado pudo cambiar precios';
    EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE 'OK rechazado con SQLSTATE 42501: %', SQLERRM;
        -- Se limpia el contexto para el resto del script
        PERFORM set_config('app.usuario_id', '', TRUE);
    END;
END $$;

\echo ''
\echo '################ BUG 11: precio_bulto se calcula solo ################'
INSERT INTO producto_proveedor_precios (proveedor_id, producto_id, precio_kg, vigente_desde)
SELECT proveedor_id, producto_id, 7.20, CURRENT_DATE + 1
  FROM producto_proveedor_precios LIMIT 1;
DO $$
DECLARE v NUMERIC;
BEGIN
    SELECT precio_bulto INTO v FROM producto_proveedor_precios
     ORDER BY id DESC LIMIT 1;
    -- 7.20 × 20 kg = 144.00
    IF v <> 144.00 THEN
        RAISE EXCEPTION 'BUG 11 NO CORREGIDO: precio_bulto = % se esperaba 144.00', v;
    END IF;
    RAISE NOTICE 'OK: precio_bulto = % (7.20 x 20kg, calculado solo)', v;
END $$;

\echo ''
\echo '################ RESUMEN ################'
SELECT 'clientes' AS entidad, count(*)::TEXT AS detalle FROM clientes
UNION ALL SELECT 'compras', count(*)::TEXT FROM compras
UNION ALL SELECT 'notas_remision', count(*)::TEXT FROM notas_remision
UNION ALL SELECT 'inventario_semanal', count(*)::TEXT FROM inventario_semanal
UNION ALL SELECT 'inventario_movimientos', count(*)::TEXT FROM inventario_movimientos
UNION ALL SELECT 'folios', count(*)::TEXT FROM folios
UNION ALL SELECT 'usuarios', count(*)::TEXT FROM usuarios;

\echo '--- Saldos finales ---'
SELECT nombre, saldo_actual FROM proveedores;
SELECT nombre, saldo_actual FROM cuentas_financieras ORDER BY nombre;
SELECT cliente, saldo_actual FROM vw_estado_cuenta_cliente;
