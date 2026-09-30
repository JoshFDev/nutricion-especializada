-- Datos de ejemplo para probar el sistema sin usar info real de clientes.
-- Correr DESPUÉS de 0001_init.sql
--
--   psql -d nutricion_especializada -f db/seeds/seed_demo.sql
--
-- Todo lo de aquí es FICTICIO. Los usuarios, clientes y proveedores
-- reales se capturan desde la aplicación, nunca se agregan a este archivo.

SET search_path TO pos, public;

-- ---------------------------------------------------------------------
-- Catálogos
-- ---------------------------------------------------------------------
INSERT INTO especies (nombre) VALUES ('Bovinos lecheros'), ('Ovinos'), ('Porcinos');
INSERT INTO categorias_producto (nombre) VALUES
    ('Sustituto lácteo'), ('Premezcla'), ('Minerales'), ('Materia prima');
INSERT INTO almacenes (nombre) VALUES ('Bodega principal');

INSERT INTO productos (codigo, nombre, categoria_id, especie_id, presentacion_kg) VALUES
    ('LAC', 'VIMILAC 400', 1, 1, 20),
    ('DHP', 'DHP-22',     2, 1, 25),
    ('MTO', 'MINERAL TRAZ', 3, 1, 5);

INSERT INTO proveedores (nombre, contacto, telefono) VALUES
    ('Distribuidora Ficticia del Norte', 'Ventas', '000-000-0000');

INSERT INTO clientes (codigo_cliente, nombre, establo, especie_id) VALUES
    ('CL01', 'Cliente de prueba', 'Establo de prueba', 1);

-- Un talonario en el formato del negocio: serie vacia (folios de puros
-- numeros) arrancando en el 2704. La serie ACTIVA ya viene vacia desde la
-- migracion 0012, asi que este es el talonario que usa el POS.
INSERT INTO folios (serie, folio_numero) VALUES ('', 2704), ('', 2705), ('', 2706);

-- ---------------------------------------------------------------------
-- Precios
-- ---------------------------------------------------------------------
INSERT INTO precios_publicos (producto_id, precio_kg)
SELECT id, 10.00 FROM productos WHERE codigo = 'LAC';

INSERT INTO precios_cliente (cliente_id, producto_id, precio_kg)
SELECT c.id, p.id, 8.50
  FROM clientes c, productos p
 WHERE c.codigo_cliente = 'CL01' AND p.codigo = 'LAC';

INSERT INTO producto_proveedor_precios (proveedor_id, producto_id, precio_kg, precio_bulto)
SELECT pr.id, p.id, 7.20, 144.00
  FROM proveedores pr, productos p
 WHERE pr.nombre = 'Distribuidora Ficticia del Norte' AND p.codigo = 'LAC';

-- ---------------------------------------------------------------------
-- Compra, venta, pago y caja: exercises los triggers de auditoría
-- ---------------------------------------------------------------------
-- Una compra con su detalle
INSERT INTO compras (proveedor_id, folio_proveedor)
SELECT id, 'F-0001' FROM proveedores
 WHERE nombre = 'Distribuidora Ficticia del Norte';

INSERT INTO compra_detalle (compra_id, producto_id, almacen_id, cantidad_bultos, precio_kg)
SELECT c.id, p.id, a.id, 100, 7.20
  FROM compras c, productos p, almacenes a, proveedores pv
 WHERE c.folio_proveedor = 'F-0001'
   AND p.codigo = 'LAC' AND a.nombre = 'Bodega principal'
   AND pv.id = c.proveedor_id;

-- Una nota de remisión con su detalle (dispara la salida de inventario)
INSERT INTO notas_remision (folio_id, cliente_id, direccion_entrega)
SELECT f.id, c.id, 'Carretera a Puebla km 12'
  FROM folios f, clientes c
 WHERE f.folio_numero = 2704 AND c.codigo_cliente = 'CL01';

INSERT INTO nota_remision_detalle (nota_id, producto_id, almacen_id,
                                   cantidad_bultos, kg_bulto, precio_unit_kg)
SELECT n.id, p.id, a.id, 10, 20, 8.50
  FROM notas_remision n, notas_remision nr, folios f,
       clientes c, productos p, almacenes a
 WHERE f.folio_numero = 2704 AND nr.folio_id = f.id AND n.id = nr.id
   AND c.codigo_cliente = 'CL01' AND n.cliente_id = c.id
   AND p.codigo = 'LAC' AND a.nombre = 'Bodega principal';

-- Un abono del cliente
INSERT INTO pagos (cliente_id, metodo, monto, requiere_factura)
SELECT id, 'Transferencia', 500.00, TRUE
  FROM clientes WHERE codigo_cliente = 'CL01';

-- Caja: un ingreso y un egreso
INSERT INTO cuentas_financieras (nombre, tipo, banco, titular) VALUES
    ('Caja chica', 'efectivo', NULL, NULL),
    ('Banco principal', 'banco', 'BANCO FICTICIO', 'Titular Ficticio');

INSERT INTO movimientos_financieros (cuenta_id, tipo, categoria, monto, descripcion)
SELECT id, 'ingreso', 'Venta', 850.00, 'Venta en efectivo del día'
  FROM cuentas_financieras WHERE nombre = 'Caja chica';

INSERT INTO movimientos_financieros (cuenta_id, tipo, categoria, monto, descripcion)
SELECT id, 'egreso', 'Flete', 250.00, 'Flete a establo'
  FROM cuentas_financieras WHERE nombre = 'Caja chica';

-- ---------------------------------------------------------------------
-- USUARIOS DE PRUEBA
--
-- Estos dos SI son ficticios y se pueden borrar. Para crear a las
-- personas reales (tu hermana y las empleadas) usa el mismo INSERT pero
-- con los datos verdaderos de cada quien, o mejor, dálos de alta desde
-- la aplicación una vez que exista la pantalla de usuarios.
--
-- OJO: la contraseña se guarda hasheada con bcrypt (nunca en texto
-- plano). La de aquí es temporal: `debe_cambiar_contrasena` está en TRUE
-- para que la oblique a cambiarla al primer ingreso.
-- ---------------------------------------------------------------------
INSERT INTO usuarios (nombre, apellido_paterno, apellido_materno, rfc,
                      email, fecha_contratacion, puesto, contrasena, es_dueno)
VALUES ('Administrador', 'De', 'Prueba', 'adp000101hdf',
        'admin@ejemplo.local', CURRENT_DATE, 'Administradora',
        crypt('CAMBIAR-ESTA-CLAVE', gen_salt('bf', 12)), TRUE);

INSERT INTO usuarios (nombre, apellido_paterno, apellido_materno, rfc,
                      email, fecha_contratacion, puesto, contrasena)
VALUES ('Empleada', 'De', 'Prueba', 'emp000101hdf',
        'empleada@ejemplo.local', CURRENT_DATE, 'Empleada',
        crypt('CAMBIAR-ESTA-CLAVE', gen_salt('bf', 12)));

INSERT INTO usuarios_roles (usuario_id, rol_id)
SELECT u.id, r.id
  FROM usuarios u JOIN roles r ON r.nombre = 'Administrador'
 WHERE u.rfc = 'ADP000101HDF';

INSERT INTO usuarios_roles (usuario_id, rol_id)
SELECT u.id, r.id
  FROM usuarios u JOIN roles r ON r.nombre = 'Empleada'
 WHERE u.rfc = 'EMP000101HDF';

-- Alertas que dispararon los triggers (stock negativo por la venta de
-- 10 bultos cuando sólo había 100... y por el saldo en cuenta).
INSERT INTO alertas (tipo, descripcion, tabla_origen)
SELECT 'demo', 'Datos de ejemplo cargados correctamente', 'seed';

-- ---------------------------------------------------------------------
-- Verificación rápida del seed
-- ---------------------------------------------------------------------
\echo '--- Existencia actual ---'
SELECT codigo, nombre, almacen, existencia_bultos
  FROM vw_existencia_actual
 WHERE existencia_bultos <> 0
 ORDER BY codigo;

\echo '--- Estado de cuenta ---'
SELECT cliente, saldo_actual, ultima_venta, ultimo_pago
  FROM vw_estado_cuenta_cliente
 WHERE ultima_venta IS NOT NULL;

\echo '--- Caja ---'
SELECT nombre, tipo, saldo_actual
  FROM cuentas_financieras ORDER BY nombre;

\echo '--- Usuarios creados (contraseña hasheada) ---'
SELECT nombre, apellido_paterno, rfc, es_dueno,
       left(contrasena, 12) || '...' AS contrasena_hasheada,
       debe_cambiar_contrasena
  FROM usuarios ORDER BY id;

\echo '--- Registros capturados en las auditorías ---'
SELECT 'auditoria_log' AS tabla, count(*) FROM auditoria_log
UNION ALL SELECT 'auditoria_caja', count(*) FROM auditoria_caja
UNION ALL SELECT 'auditoria_inventario', count(*) FROM auditoria_inventario
UNION ALL SELECT 'auditoria_precios', count(*) FROM auditoria_precios
ORDER BY 1;
