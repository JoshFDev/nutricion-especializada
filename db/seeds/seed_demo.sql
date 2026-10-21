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
--
-- Todo se inserta por NOMBRE y nunca por id. Los ids los pone la
-- secuencia, y la secuencia no vuelve a cero: si el seed se aplica dos
-- veces (o sobre una base donde ya habia catalogos), la segunda vez los
-- ids seria otros y las referencias por id apuntarian a filas que no
-- existen. Con el nombre, el seed se puede volver a aplicar las veces que
-- haga falta.
-- ---------------------------------------------------------------------
INSERT INTO especies (nombre) VALUES ('Bovinos lecheros'), ('Ovinos'), ('Porcinos')
    ON CONFLICT (nombre) DO NOTHING;
INSERT INTO categorias_producto (nombre) VALUES
    ('Sustituto lácteo'), ('Premezcla'), ('Minerales'), ('Materia prima')
    ON CONFLICT (nombre) DO NOTHING;
INSERT INTO almacenes (nombre) VALUES ('Bodega principal')
    ON CONFLICT (nombre) DO NOTHING;

INSERT INTO productos (codigo, nombre, categoria_id, especie_id, presentacion_kg)
SELECT v.codigo, v.nombre, c.id, e.id, v.presentacion_kg
  FROM (VALUES
      ('LAC', 'VIMILAC 400',   'Sustituto lácteo', 'Bovinos lecheros', 20),
      ('DHP', 'DHP-22',        'Premezcla',        'Bovinos lecheros', 25),
      ('MTO', 'MINERAL TRAZ',  'Minerales',        'Bovinos lecheros',  5)
  ) AS v(codigo, nombre, categoria, especie, presentacion_kg)
  JOIN categorias_producto c ON c.nombre = v.categoria
  JOIN especies e            ON e.nombre = v.especie
ON CONFLICT (codigo) DO NOTHING;

INSERT INTO proveedores (nombre, contacto, telefono) VALUES
    ('Distribuidora Ficticia del Norte', 'Ventas', '000-000-0000')
    ON CONFLICT (nombre) DO NOTHING;

INSERT INTO clientes (codigo_cliente, nombre, establo, especie_id)
SELECT 'CL01', 'Cliente de prueba', 'Establo de prueba', e.id
  FROM especies e WHERE e.nombre = 'Bovinos lecheros'
ON CONFLICT (codigo_cliente) DO NOTHING;

-- Un talonario en el formato del negocio: serie vacia (folios de puros
-- numeros) arrancando en el 2704. La serie ACTIVA ya viene vacia desde la
-- migracion 0012, asi que este es el talonario que usa el POS.
INSERT INTO folios (serie, folio_numero) VALUES ('', 2704), ('', 2705), ('', 2706)
    ON CONFLICT (serie, folio_numero) DO NOTHING;

-- ---------------------------------------------------------------------
-- Precios
--
-- Aqui el `ON CONFLICT DO NOTHING` NO sirve: el traslape de vigencias lo
-- avisa un TRIGGER (0007) con un RAISE EXCEPTION, no una restriccion, y
-- un ON CONFLICT solo puede absorber violaciones de restriccion. Por eso
-- la guarda es un "si no hay ya uno vigente" explicito.
-- ---------------------------------------------------------------------
INSERT INTO precios_publicos (producto_id, precio_kg)
SELECT id, 10.00 FROM productos
 WHERE codigo = 'LAC'
   AND NOT EXISTS (SELECT 1 FROM precios_publicos p
                    WHERE p.producto_id = productos.id
                      AND p.vigente_hasta IS NULL);

INSERT INTO precios_cliente (cliente_id, producto_id, precio_kg)
SELECT c.id, p.id, 8.50
  FROM clientes c, productos p
 WHERE c.codigo_cliente = 'CL01' AND p.codigo = 'LAC'
   AND NOT EXISTS (SELECT 1 FROM precios_cliente pp
                    WHERE pp.cliente_id = c.id AND pp.producto_id = p.id
                      AND pp.vigente_hasta IS NULL);

INSERT INTO producto_proveedor_precios (proveedor_id, producto_id, precio_kg, precio_bulto)
SELECT pr.id, p.id, 7.20, 144.00
  FROM proveedores pr, productos p
 WHERE pr.nombre = 'Distribuidora Ficticia del Norte' AND p.codigo = 'LAC'
   AND NOT EXISTS (SELECT 1 FROM producto_proveedor_precios pp
                    WHERE pp.proveedor_id = pr.id AND pp.producto_id = p.id
                      AND pp.vigente_hasta IS NULL);

-- ---------------------------------------------------------------------
-- Compra, venta, pago y caja: exercises los triggers de auditoría
--
-- Estas NO tienen llave natural que las ate a algo unico, asi que se
-- guardan con un "si no existe ya" explicito: sin eso, aplicar el seed
-- dos veces duplicaria la compra, la nota y los movimientos de caja, y
-- los saldos saldrian el doble de la cuenta.
-- ---------------------------------------------------------------------
-- Una compra con su detalle
INSERT INTO compras (proveedor_id, folio_proveedor)
SELECT id, 'F-0001' FROM proveedores
 WHERE nombre = 'Distribuidora Ficticia del Norte'
   AND NOT EXISTS (SELECT 1 FROM compras c2 WHERE c2.folio_proveedor = 'F-0001');

INSERT INTO compra_detalle (compra_id, producto_id, almacen_id, cantidad_bultos, precio_kg)
SELECT c.id, p.id, a.id, 100, 7.20
  FROM compras c, productos p, almacenes a, proveedores pv
 WHERE c.folio_proveedor = 'F-0001'
   AND p.codigo = 'LAC' AND a.nombre = 'Bodega principal'
   AND pv.id = c.proveedor_id
   AND NOT EXISTS (SELECT 1 FROM compra_detalle cd WHERE cd.compra_id = c.id);

-- Una nota de remisión con su detalle (dispara la salida de inventario)
INSERT INTO notas_remision (folio_id, cliente_id, direccion_entrega)
SELECT f.id, c.id, 'Carretera a Puebla km 12'
  FROM folios f, clientes c
 WHERE f.folio_numero = 2704 AND c.codigo_cliente = 'CL01'
   AND NOT EXISTS (SELECT 1 FROM notas_remision n2 WHERE n2.folio_id = f.id);

INSERT INTO nota_remision_detalle (nota_id, producto_id, almacen_id,
                                   cantidad_bultos, kg_bulto, precio_unit_kg)
SELECT n.id, p.id, a.id, 10, 20, 8.50
  FROM notas_remision n, notas_remision nr, folios f,
       clientes c, productos p, almacenes a
 WHERE f.folio_numero = 2704 AND nr.folio_id = f.id AND n.id = nr.id
   AND c.codigo_cliente = 'CL01' AND n.cliente_id = c.id
   AND p.codigo = 'LAC' AND a.nombre = 'Bodega principal'
   AND NOT EXISTS (SELECT 1 FROM nota_remision_detalle d WHERE d.nota_id = n.id);

-- Un abono del cliente
INSERT INTO pagos (cliente_id, metodo, monto, requiere_factura)
SELECT id, 'Transferencia', 500.00, TRUE
  FROM clientes
 WHERE codigo_cliente = 'CL01'
   AND NOT EXISTS (SELECT 1 FROM pagos p2
                    WHERE p2.cliente_id = clientes.id
                      AND p2.monto = 500.00 AND p2.metodo = 'Transferencia');

-- Caja: un ingreso y un egreso
INSERT INTO cuentas_financieras (nombre, tipo, banco, titular) VALUES
    ('Caja chica', 'efectivo', NULL, NULL),
    ('Banco principal', 'banco', 'BANCO FICTICIO', 'Titular Ficticio')
ON CONFLICT (nombre) DO NOTHING;

INSERT INTO movimientos_financieros (cuenta_id, tipo, categoria, monto, descripcion)
SELECT id, 'ingreso', 'Venta', 850.00, 'Venta en efectivo del día'
  FROM cuentas_financieras
 WHERE nombre = 'Caja chica'
   AND NOT EXISTS (SELECT 1 FROM movimientos_financieros m
                    WHERE m.categoria = 'Venta' AND m.descripcion = 'Venta en efectivo del día');

INSERT INTO movimientos_financieros (cuenta_id, tipo, categoria, monto, descripcion)
SELECT id, 'egreso', 'Flete', 250.00, 'Flete a establo'
  FROM cuentas_financieras
 WHERE nombre = 'Caja chica'
   AND NOT EXISTS (SELECT 1 FROM movimientos_financieros m
                    WHERE m.categoria = 'Flete' AND m.descripcion = 'Flete a establo');

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
        crypt('CAMBIAR-ESTA-CLAVE', gen_salt('bf', 12)), TRUE)
ON CONFLICT (rfc) DO NOTHING;

INSERT INTO usuarios (nombre, apellido_paterno, apellido_materno, rfc,
                      email, fecha_contratacion, puesto, contrasena)
VALUES ('Empleada', 'De', 'Prueba', 'emp000101hdf',
        'empleada@ejemplo.local', CURRENT_DATE, 'Empleada',
        crypt('CAMBIAR-ESTA-CLAVE', gen_salt('bf', 12)))
ON CONFLICT (rfc) DO NOTHING;

INSERT INTO usuarios_roles (usuario_id, rol_id)
SELECT u.id, r.id
  FROM usuarios u JOIN roles r ON r.nombre = 'Administrador'
 WHERE u.rfc = 'ADP000101HDF'
   AND NOT EXISTS (SELECT 1 FROM usuarios_roles ur
                    WHERE ur.usuario_id = u.id AND ur.rol_id = r.id);

INSERT INTO usuarios_roles (usuario_id, rol_id)
SELECT u.id, r.id
  FROM usuarios u JOIN roles r ON r.nombre = 'Empleada'
 WHERE u.rfc = 'EMP000101HDF'
   AND NOT EXISTS (SELECT 1 FROM usuarios_roles ur
                    WHERE ur.usuario_id = u.id AND ur.rol_id = r.id);

-- Alertas que dispararon los triggers (stock negativo por la venta de
-- 10 bultos cuando sólo había 100... y por el saldo en cuenta).
INSERT INTO alertas (tipo, descripcion, tabla_origen)
SELECT 'demo', 'Datos de ejemplo cargados correctamente', 'seed'
WHERE NOT EXISTS (SELECT 1 FROM alertas a
                   WHERE a.tipo = 'demo' AND a.tabla_origen = 'seed');

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
