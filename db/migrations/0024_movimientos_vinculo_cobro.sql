-- 0024: el movimiento de caja apunta al cobro que lo origino.
--
-- CONTEXTO. Un cobro se anotaba en DOS lugares y no habia forma de cruzarlos:
--
--   - en `pagos`, que es la CARTERA (lo que el cliente debe);
--   - en `movimientos_financieros`, que es la CAJA (de donde salio el dinero).
--
-- Los dos tienen el mismo monto y el mismo cliente, asi que al conciliar
-- habia que compararlos "a ojo" y no habia forma de saber si faltaba uno o
-- sobraba otro. Un cobro duplicado en la caja (o sin su movimiento) se
-- comia el saldo de una cuenta sin que nadie lo notara.
--
-- QUE HACE ESTA MIGRACION
--
-- 1. `movimientos_financieros.pago_id` y `.pago_proveedor_id`: el vinculo
--    con el documento de cartera que produjo el movimiento. Con eso, un
--    cobro se puede seguir de punta a punta: la nota que cubrio, el pago
--    que la liquidó y el movimiento de caja que salio de ahi.
--
-- 2. Un indice UNICO por vinculo: un cobro no puede tener dos movimientos
--    de caja, y un pago a proveedor tampoco. Es lo que convierte el
--    "se anota dos veces" de un descuido posible en un imposible.
--
--    El indice es PARCIAL (solo las filas que tienen vinculo): un
--    movimiento de caja que no viene de un cobro (renta, flete, nomina)
--    no compite con nada.
--
-- NOTA. La columna no es NOT NULL a proposito: la mayoria de los
-- movimientos de caja no vienen de un cobro (son gastos fijos), y no tiene
-- sentido obligar a que cada uno diga de donde salio.
--
-- CONVENCION (ver backend/scripts/migrar.ts): sin BEGIN/COMMIT y sin
-- INSERT en schema_migrations. Eso es del runner.

-- ------------------------------------------------------------------ 1
--
-- El vinculo con el cobro de la cartera.
ALTER TABLE pos.movimientos_financieros
    ADD COLUMN IF NOT EXISTS pago_id BIGINT REFERENCES pos.pagos(id);

-- Y con el pago a proveedor.
ALTER TABLE pos.movimientos_financieros
    ADD COLUMN IF NOT EXISTS pago_proveedor_id BIGINT REFERENCES pos.pagos_proveedor(id);

COMMENT ON COLUMN pos.movimientos_financieros.pago_id IS
    'El cobro de la cartera que produjo este movimiento. NULL cuando el movimiento no viene de un cobro (renta, flete, nomina).';
COMMENT ON COLUMN pos.movimientos_financieros.pago_proveedor_id IS
    'El pago a proveedor que produjo este movimiento. NULL cuando el movimiento no viene de un pago a proveedor.';

-- ------------------------------------------------------------------ 2
--
-- Un cobro, un movimiento. El indice es lo que hace que el doble asiento
-- sea imposible y no solo improbable.
CREATE UNIQUE INDEX IF NOT EXISTS ux_movimientos_pago
    ON pos.movimientos_financieros (pago_id)
    WHERE pago_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_movimientos_pago_proveedor
    ON pos.movimientos_financieros (pago_proveedor_id)
    WHERE pago_proveedor_id IS NOT NULL;

-- Y los indices de consulta: la conciliacion busca por el vinculo, y el
-- filtro de la caja busca por cliente y por proveedor.
CREATE INDEX IF NOT EXISTS idx_movimientos_cliente
    ON pos.movimientos_financieros (cliente_id)
    WHERE cliente_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_movimientos_proveedor
    ON pos.movimientos_financieros (proveedor_id)
    WHERE proveedor_id IS NOT NULL;
