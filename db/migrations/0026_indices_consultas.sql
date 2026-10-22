-- 0026: los indices que faltan para las consultas que el sistema hace.
--
-- CONTEXTO. La base tiene sus indices, pero cinco consultas del sistema
-- NO los usaban, y se notaba: cada listado ordenaba y paginaba sobre una
-- tabla completa.
--
-- Un indice mal puesto no es "un indice de mas": es un indice que no
-- sirve para lo que se le pidio, y ademas se paga en cada escritura de
-- la tabla. Por eso este archivo tambien suelta uno que esta en el
-- lugar equivocado.
--
-- QUE SE AGREGA
--
-- 1. `pagos (fecha DESC, id DESC)`. El listado de cobranza ordena por
--    `p.fecha DESC, p.id DESC` y pagina. El indice que habia era
--    `(cliente_id, fecha DESC)`, que solo sirve cuando se filtra por
--    cliente, y el listado tambien se usa sin filtro.
--
-- 2. `movimientos_financieros (categoria)`. El filtro por categoria de
--    la caja lo usaba entero: la tabla se recorria entera.
--
-- 3. `notas_remision (estatus)`. El POS filtra por estatus (pendiente,
--    parcial, pagada, cancelada) y no habia indice para eso.
--
-- 4. `usuarios (nombre, apellido_paterno)`. El listado de usuarios
--    ordena por `u.nombre, u.apellido_paterno`. El indice que habia
--    era `(apellido_paterno, apellido_materno, nombre)`: el mismo
--    nombre, el mismo orden de columnas al reves, y por lo tanto
--    inútil para ese ORDER BY. Se suelta y se pone el que sirve.
--    Nada en el sistema ordena por los apellidos.
--
-- 5. `inventario_movimientos (producto_id, almacen_id)`. La existencia de
--    un producto en un almacén se calcula sumando sus movimientos, y las
--    dos funciones que lo hacen (`fn_existencia_de` y
--    `fn_verificar_stock`) filtran por las DOS columnas a la vez. El
--    indice que habia era `(producto_id, fecha)`, que no las dos.
--
-- NOTA. `clientes.saldo_actual` y `proveedores.saldo_actual` ya tienen
-- indice propio, y `movimientos_financieros (cliente_id)` y
-- `(proveedor_id)` los trajo la migracion 0024 con el vinculo del cobro.
--
-- CONVENCION (ver backend/scripts/migrar.ts): sin BEGIN/COMMIT y sin
-- INSERT en schema_migrations. Eso es del runner.

-- ------------------------------------------------------------------ 1
--
-- El listado de cobranza sin filtro por cliente.
CREATE INDEX IF NOT EXISTS idx_pagos_fecha
    ON pos.pagos (fecha DESC, id DESC);

-- ------------------------------------------------------------------ 2
--
-- El filtro por categoria de la caja.
CREATE INDEX IF NOT EXISTS idx_movimientos_categoria
    ON pos.movimientos_financieros (categoria);

-- ------------------------------------------------------------------ 3
--
-- El filtro por estatus del POS.
CREATE INDEX IF NOT EXISTS idx_notas_estatus
    ON pos.notas_remision (estatus);

-- ------------------------------------------------------------------ 4
--
-- Se suelta el indice que estaba en el orden equivocado y se pone el que
-- sirve para el ORDER BY real del listado.
--
-- `idx_usuarios_nombre` estaba en `(apellido_paterno, apellido_materno,
-- nombre)`: al reves de como ordena el listado, asi que PostgreSQL no
-- lo puede usar para el sort y tiene que ordenar la tabla entera en
-- memoria. Y se sigue pagando en cada alta y cada cambio de una cuenta.
DROP INDEX IF EXISTS pos.idx_usuarios_nombre;

CREATE INDEX IF NOT EXISTS idx_usuarios_orden
    ON pos.usuarios (nombre, apellido_paterno);

-- ------------------------------------------------------------------ 5
--
-- La existencia se calcula sobre (producto, almacen), no sobre
-- (producto, fecha).
CREATE INDEX IF NOT EXISTS idx_inv_mov_producto_almacen
    ON pos.inventario_movimientos (producto_id, almacen_id);
