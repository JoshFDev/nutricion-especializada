-- 0023: limpiar la rama muerta de fn_validar_aplicacion_pago y dejar las
--        alertas de stock negativo al alcance.
--
-- CONTEXTO. Dos cosas pequenas, del mismo tipo: cosas que la base hace
-- bien, pero que estan escritas de una forma que confunde.
--
-- 1) LA RAMA MUERTA DE `fn_validar_aplicacion_pago`.
--
--    La funcion tiene esto:
--
--        IF NEW.id IS NULL THEN
--            v_disponible_nota := v_subtotal - (lo ya aplicado a la nota)
--        ELSE
--            v_disponible_nota := v_subtotal - (lo ya aplicado a la nota SIN ESTA fila)
--        END IF;
--
--    La rama del `IF` NUNCA se toma: `pagos_aplicacion.id` es un
--    BIGSERIAL PRIMARY KEY, asi que en un INSERT la secuencia ya le
--    asigno el id antes de que el trigger corra. Y en un UPDATE, `NEW.id`
--    es el id de siempre. O sea, `NEW.id` nunca es NULL.
--
--    No rompia nada (la rama muerta calculaba lo mismo que la otra,
--    porque en un INSERT todavia no hay fila que excluir), pero sugeria
--    que el autor creia que el id podia venir NULL, y no decia cual de
--    las dos formulas era la buena. Este archivo deja una sola, y
--    explica por que.
--
-- 2) LAS ALERTAS DE STOCK NEGATIVO.
--
--    El trigger `fn_verificar_stock` inserta una fila en `alertas` cada vez
--    que un movimiento deja el stock en negativo. Nadie las leia: la tabla
--    crecia sin limite y no tenia indice, y el aviso de "el producto se
--    acabo" no llegaba a ninguna pantalla.
--
--    El estado ACTUAL del stock si se ve (la pantalla de inventario tiene
--    el filtro `vacios`, que muestra lo que esta en cero o en negativo), asi
--    que lo que faltaba era el HISTORICO: cuando se quedo sin, y desde
--    que movimiento.
--
--    Con esta migracion, las alertas se pueden consultar por la API
--    (`GET /api/reportes/alertas`, con el permiso `reportes.ver`) y la
--    tabla tiene indice para que esa consulta no sea un barrido.
--
-- CONVENCION (ver backend/scripts/migrar.ts): sin BEGIN/COMMIT y sin
-- INSERT en schema_migrations. Eso es del runner.

-- ------------------------------------------------------------------ 1
--
-- Se vuelve a definir la MISMA funcion, con la rama muerta quitada.
--
-- `v_id_actual` ya era `COALESCE(NEW.id, 0)`, y como el id nunca es
-- NULL, comparar con 0 es lo mismo que excluir la fila. La forma que
-- queda dice explicitamente que se excluye la fila que se esta
-- tocando, y asi el UPDATE no se cuenta a si mismo.
CREATE OR REPLACE FUNCTION pos.fn_validar_aplicacion_pago()
RETURNS TRIGGER AS $$
DECLARE
    v_pago_id  BIGINT  := NEW.pago_id;
    v_nota_id  BIGINT  := NEW.nota_id;
    v_monto    NUMERIC := NEW.monto_aplicado;
    -- El id de la fila que se esta tocando. En un INSERT la secuencia ya
    -- se lo asigno, asi que nunca es NULL; el COALESCE queda por si
    -- alguien la llama desde un contexto donde no lo tenga.
    v_id_actual BIGINT := COALESCE(NEW.id, 0);
    v_disponible_pago NUMERIC;
    v_disponible_nota NUMERIC;
    v_subtotal  NUMERIC;
BEGIN
    SELECT monto INTO v_disponible_pago FROM pagos WHERE id = v_pago_id;
    -- Lo ya aplicado a ESE pago, sin contar esta fila.
    v_disponible_pago := v_disponible_pago - COALESCE(
        (SELECT SUM(monto_aplicado) FROM pos.pagos_aplicacion
          WHERE pago_id = v_pago_id AND id <> v_id_actual), 0);

    IF v_monto > v_disponible_pago THEN
        RAISE EXCEPTION
            'El pago % sólo tiene % disponible y se intentó aplicar %',
            v_pago_id, v_disponible_pago, v_monto
            USING ERRCODE = '23514';
    END IF;

    SELECT subtotal INTO v_subtotal FROM pos.notas_remision WHERE id = v_nota_id;
    -- Lo ya aplicado a ESA nota, sin contar esta fila: en un UPDATE hay
    -- que excluirla, o el trigger se contaria a si mismo y el pago
    -- pareceria no caber.
    v_disponible_nota := v_subtotal - COALESCE(
        (SELECT SUM(monto_aplicado) FROM pos.pagos_aplicacion
          WHERE nota_id = v_nota_id AND id <> v_id_actual), 0);

    IF v_monto > v_disponible_nota THEN
        RAISE EXCEPTION
            'La nota % sólo tiene % por cubrir y se intentó aplicar %',
            v_nota_id, v_disponible_nota, v_monto
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION pos.fn_validar_aplicacion_pago() IS
    'Revisa que una aplicacion de pago no exceda el pago ni lo que la nota '
    'debe. Se excluye la fila que se esta tocando (id <> v_id_actual), que '
    'en un UPDATE existe y en un INSERT todavia no.';

-- ------------------------------------------------------------------ 2
--
-- El indice que le hace falta a la consulta de alertas: se piden por
-- fecha, de la mas nueva a la mas vieja.
CREATE INDEX IF NOT EXISTS idx_alertas_creado ON pos.alertas (creado_en DESC);

-- Y uno por el tipo, para poder filtrar solo las de stock negativo.
CREATE INDEX IF NOT EXISTS idx_alertas_tipo ON pos.alertas (tipo);

-- `atendida` dice si alguien ya la vio. Sin `NOT NULL` el valor es
-- NULL en vez de FALSE, y cualquier consulta que la use tiene que
-- acordarse de los dos casos. Se cierra con el mismo valor por omision
-- que ya tenian las filas.
ALTER TABLE pos.alertas
    ALTER COLUMN atendida SET DEFAULT FALSE;

UPDATE pos.alertas SET atendida = FALSE WHERE atendida IS NULL;

ALTER TABLE pos.alertas
    ALTER COLUMN atendida SET NOT NULL;

COMMENT ON COLUMN pos.alertas.atendida IS
    'Si alguien ya reviso esta alerta. Nadie la marca todavia: la consulta '
    'de alertas las devuelve todas.';
