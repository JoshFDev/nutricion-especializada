-- Limpieza de datos operacionales de pos, conservando la configuracion.
--
-- Lo que se borra es todo lo que uno genera: productos, precios, compras,
-- notas de remision, movimientos de inventario, clientes, proveedores y
-- la auditoria completa.
--
-- Lo que se conserva es lo que se configuro una vez y hace falta para
-- entrar y operar: usuarios, roles, permisos, almacen, cuentas
-- financieras, categorias, especies y la serie de folios.
--
-- NO lleva CASCADE a proposito: si alguien agrega despues una tabla que
-- apunte a algo de esta lista, el truncate se va a quejar en vez de
-- borrar en cascada datos que no estaban en la lista.

BEGIN;

TRUNCATE TABLE pos.productos,
               pos.precios_publicos,
               pos.precios_cliente,
               pos.producto_proveedor_precios,
               pos.compras,
               pos.compra_detalle,
               pos.notas_remision,
               pos.nota_remision_detalle,
               pos.inventario_movimientos,
               pos.inventario_semanal,
               pos.movimientos_financieros,
               pos.pagos,
               pos.pagos_aplicacion,
               pos.pagos_proveedor,
               pos.facturas,
               pos.factura_nota,
               pos.clientes,
               pos.datos_fiscales_cliente,
               pos.direcciones_entrega,
               pos.proveedores,
               pos.alertas,
               pos.auditoria_log,
               pos.auditoria_accesos,
               pos.auditoria_caja,
               pos.auditoria_inventario,
               pos.auditoria_precios,
               pos.sesiones
         RESTART IDENTITY;

COMMIT;
