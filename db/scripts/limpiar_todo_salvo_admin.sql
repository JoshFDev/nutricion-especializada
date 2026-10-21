-- Limpieza TOTAL: deja la base como recién migrada, con un solo usuario.
--
-- Para probar el sistema desde cero: se borra todo lo que se ha capturado y
-- todos los catálogos, y queda solamente la cuenta del administrador.
--
--   psql -d <base> -f db/scripts/limpiar_todo_salvo_admin.sql
--
-- ANTES de correr esto, un respaldo. Sin él no hay vuelta atrás:
--
--   pg_dump -d <base> -f /ruta/algun/lado/respaldo.sql
--
--
-- Lo que QUEDA, y por qué:
--
--   - El usuario con `es_dueno` (la dueña del negocio). Es el único que
--     queda porque es el que administra usuarios y ve la auditoría; si se
--     borra, no se puede entrar a hacer nada.
--
--   - Los roles, los permisos y la relación entre los dos. Eso es la
--     configuración del acceso, no datos: sin ella el administrador entra
--     pero no puede hacer nada.
--
--   - La numeración de folios (`folios` y la serie activa). NO hay pantalla
--     para rehacerla, así que si se borra el punto de venta se queda sin
--     talonario y no puede emitir una nota de remisión.
--
--
-- Lo que SE VA: todo lo demás. Clientes, proveedores, productos, precios,
-- compras, notas de remisión, inventario, pagos, facturas, almacenes,
-- categorías, especies, cuentas de caja, la auditoría y las sesiones.
--
--
-- El orden importa, y hay dos cosas que lo mandan:
--
--   1. La auditoría y las notas de remisión apuntan a `usuarios` con
--      "ON DELETE NO ACTION": mientras haya filas ahí, borrar un usuario
--      se rebota. Por eso se vacían PRIMERO las tablas y después se borran
--      las cuentas.
--
--   2. `TRUNCATE` no dispara los triggers de fila, así que vaciar por
--      `TRUNCATE` no dispara los de saldo ni los de inventario. No hace
--      falta "deshacer" nada: las sumas se recalculan solas cuando llega
--      el primer movimiento nuevo.
--
--
-- NO lleva CASCADE a propósito: si alguien agrega después una tabla que
-- apunte a algo de esta lista, el truncate se va a quejar en vez de borrar
-- en cascada datos que no estaban en la lista.

BEGIN;

-- ---------------------------------------------------------------------
-- 0. Que haya exactamente un dueño.
--
-- El script se guía por `es_dueno`, así que si hay dos o ninguno no hay
-- forma de saber a quién dejar. Se para aquí y avisa.
-- ---------------------------------------------------------------------
DO $$
DECLARE
    v_dueños INT;
BEGIN
    SELECT count(*) INTO v_dueños FROM pos.usuarios WHERE es_dueno;
    IF v_dueños <> 1 THEN
        RAISE EXCEPTION
            'Se esperaba exactamente un usuario con es_dueno y hay %. Revisa pos.usuarios antes de seguir.',
            v_dueños;
    END IF;
END
$$;

-- ---------------------------------------------------------------------
-- 1. Vaciar todo lo capturable y todos los catálogos.
--
-- Es un solo TRUNCATE porque las tablas se apuntan entre sí: si se
-- vaciaran por partes, la segunda se quejaría de que la primera todavía
-- tiene filas que la apuntan.
-- ---------------------------------------------------------------------
TRUNCATE TABLE pos.alertas,
               pos.almacenes,
               pos.auditoria_accesos,
               pos.auditoria_caja,
               pos.auditoria_inventario,
               pos.auditoria_log,
               pos.auditoria_precios,
               pos.categorias_producto,
               pos.clientes,
               pos.compra_detalle,
               pos.compras,
               pos.cuentas_financieras,
               pos.datos_fiscales_cliente,
               pos.direcciones_entrega,
               pos.especies,
               pos.factura_nota,
               pos.facturas,
               pos.inventario_movimientos,
               pos.inventario_semanal,
               pos.movimientos_financieros,
               pos.nota_remision_detalle,
               pos.notas_remision,
               pos.pagos,
               pos.pagos_aplicacion,
               pos.pagos_proveedor,
               pos.precios_cliente,
               pos.precios_publicos,
               pos.producto_proveedor_precios,
               pos.productos,
               pos.proveedores,
               pos.sesiones,
               pos.usuarios_codigo_baja
          RESTART IDENTITY;

-- ---------------------------------------------------------------------
-- 2. Las cuentas que no son del dueño.
--
-- Se van sus roles y sus códigos de baja con la cascada de la llave
-- foránea, y las sesiones con ellos.
-- ---------------------------------------------------------------------
DELETE FROM pos.usuarios WHERE es_dueno = false;

-- ---------------------------------------------------------------------
-- 3. Limpiar la huella del borrón.
--
-- El trigger de auditoría de `usuarios` deja un renglón de "se borró la
-- cuenta". Se quita para que la bitácora empiece limpia, como si el
-- sistema se acabara de instalar.
-- ---------------------------------------------------------------------
TRUNCATE TABLE pos.auditoria_log;

COMMIT;
