\set ON_ERROR_STOP on
SET search_path TO pos, public;

-- ------------------------------------------------------------------
-- 1. Alta de usuarios
-- ------------------------------------------------------------------
INSERT INTO usuarios (nombre, apellido_paterno, apellido_materno, rfc,
                      email, fecha_contratacion, puesto, contrasena, es_dueno)
VALUES ('Marta', 'Nava', 'Ruiz', 'NENR800101HDF', 'marta@ejemplo.mx',
        '2020-03-15', 'Administradora', crypt('Clave-Fuera-1', gen_salt('bf', 12)), TRUE);

INSERT INTO usuarios (nombre, apellido_paterno, apellido_materno, rfc,
                      fecha_contratacion, puesto, contrasena)
VALUES ('Ana', 'Torres', 'Gil', 'ATG900202MDF', '2024-07-01', 'Empleada',
        crypt('Clave-Empleada-1', gen_salt('bf', 12)));

INSERT INTO usuarios_roles (usuario_id, rol_id)
SELECT u.id, r.id FROM usuarios u, roles r
 WHERE u.rfc = 'NENR800101HDF' AND r.nombre = 'Administrador';
INSERT INTO usuarios_roles (usuario_id, rol_id)
SELECT u.id, r.id FROM usuarios u, roles r
 WHERE u.rfc = 'ATG900202MDF' AND r.nombre = 'Empleada';

-- RFC normalizado a mayúsculas y sin espacios
INSERT INTO usuarios (nombre, apellido_paterno, rfc, fecha_contratacion, contrasena)
VALUES ('Prueba', 'Minusculas', '  pmn111203hdf  ', '2025-01-01', crypt('x', gen_salt('bf',12)));

-- ------------------------------------------------------------------
-- 2. Contraseñas: el hash NO es el texto plano
-- ------------------------------------------------------------------
SELECT '--- hash bcrypt (nunca plaintext) ---' AS prueba;
SELECT substring(contrasena, 1, 20) || '...' AS contrasena_guardada
  FROM usuarios WHERE rfc = 'NENR800101HDF';
SELECT '--- validar contraseña correcta ---' AS prueba;
SELECT crypt('Clave-Fuera-1', contrasena) = contrasena AS acepta_correcta,
       crypt('clave-mal',   contrasena) = contrasena AS acepta_mala
  FROM usuarios WHERE rfc = 'NENR800101HDF';
SELECT '--- RFC normalizado ---' AS prueba;
SELECT rfc FROM usuarios WHERE apellido_paterno = 'Minusculas';

-- ------------------------------------------------------------------
-- 3. Permisos: admin vs empleada
-- ------------------------------------------------------------------
SELECT '--- admin: todo ---' AS prueba;
BEGIN;
SELECT fn_iniciar_sesion((SELECT id FROM usuarios WHERE rfc='NENR800101HDF'), '10.0.0.5');
SELECT fn_es_admin() AS es_admin,
       fn_tiene_permiso('caja.eliminar') AS puede_borrar_caja,
       fn_tiene_permiso('usuarios.crear')  AS puede_crear_usuarios,
       fn_usuario_actual() AS usuario_actual,
       fn_usuario_actual_ip() AS ip;
COMMIT;

SELECT '--- empleada: sin lo sensible ---' AS prueba;
BEGIN;
SELECT fn_iniciar_sesion((SELECT id FROM usuarios WHERE rfc='ATG900202MDF'), '10.0.0.9');
SELECT fn_tiene_permiso('notas.crear')     AS puede_vender,
       fn_tiene_permiso('caja.capturar')   AS puede_cobrar,
       fn_tiene_permiso('caja.eliminar')   AS puede_borrar_caja,
       fn_tiene_permiso('precios.editar')  AS puede_cambiar_precios,
       fn_tiene_permiso('usuarios.crear')  AS puede_crear_usuarios,
       fn_tiene_permiso('auditoria.caja')  AS puede_ver_auditoria_caja;
COMMIT;

SELECT '--- sin sesión = sin permisos ---' AS prueba;
SELECT fn_usuario_actual() AS usuario_actual,
       fn_tiene_permiso('notas.crear') AS puede_vender;

-- ------------------------------------------------------------------
-- 4. Montaje mínimo para disparar los triggers de auditoría
-- ------------------------------------------------------------------
INSERT INTO almacenes (nombre) VALUES ('Bodega') ON CONFLICT DO NOTHING;
INSERT INTO productos (codigo, nombre, presentacion_kg) VALUES ('LAC','VIMILAC 400', 20)
  ON CONFLICT (codigo) DO NOTHING;
INSERT INTO clientes (codigo_cliente, nombre) VALUES ('CL01','Cliente de prueba') ON CONFLICT (codigo_cliente) DO NOTHING;
-- Serie propia 'T': el seed ya usa la serie A
SELECT fn_allegar_folios('T', 9000, 9000);
INSERT INTO cuentas_financieras (nombre, tipo) VALUES ('Caja chica','efectivo')
  ON CONFLICT (nombre) DO NOTHING;

-- ------------------------------------------------------------------
-- 5. Trigger de folios sigue funcionando
-- ------------------------------------------------------------------
BEGIN;
SELECT fn_iniciar_sesion((SELECT id FROM usuarios WHERE rfc='ATG900202MDF'), '10.0.0.9');
INSERT INTO notas_remision (folio_id, cliente_id, vendedor_id)
SELECT f.id, c.id, u.id
  FROM folios f, clientes c, usuarios u
 WHERE f.serie='T' AND f.folio_numero=9000
   AND c.codigo_cliente='CL01' AND u.rfc='ATG900202MDF';
COMMIT;

SELECT '--- reutilizar el mismo folio debe FALLAR ---' AS prueba;
DO $$
BEGIN
    INSERT INTO notas_remision (folio_id, cliente_id)
    SELECT f.id, c.id FROM folios f, clientes c
     WHERE f.serie='T' AND f.folio_numero=9000 AND c.codigo_cliente='CL01';
    RAISE EXCEPTION 'NO FALLÓ: el trigger de folios no bloqueó el reuso';
EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'NO FALLÓ%' THEN RAISE; END IF;
    RAISE NOTICE 'OK bloqueado: %', SQLERRM;
END $$;

-- ------------------------------------------------------------------
-- 6. Auditoría de inventario (ajuste con motivo)
-- ------------------------------------------------------------------
SELECT '--- ajuste SIN motivo debe FALLAR ---' AS prueba;
DO $$
BEGIN
    INSERT INTO inventario_movimientos (producto_id, almacen_id, tipo, cantidad_bultos)
    SELECT pr.id, a.id, 'ajuste_negativo', 3 FROM productos pr, almacenes a
     WHERE pr.codigo='LAC' AND a.nombre='Bodega';
    RAISE EXCEPTION 'NO FALLÓ: se aceptó un ajuste sin motivo';
EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'NO FALLÓ%' THEN RAISE; END IF;
    RAISE NOTICE 'OK bloqueado: %', SQLERRM;
END $$;

SELECT '--- la EMPLEADA no puede ajustar inventario (permiso en la BD) ---' AS prueba;
DO $$
BEGIN
    PERFORM set_config('app.usuario_id',
        (SELECT id::TEXT FROM usuarios WHERE rfc='ATG900202MDF'), TRUE);
    INSERT INTO inventario_movimientos (producto_id, almacen_id, tipo,
                                        cantidad_bultos, motivo)
    SELECT pr.id, a.id, 'ajuste_negativo', 3, 'prueba sin permiso'
      FROM productos pr, almacenes a
     WHERE pr.codigo='LAC' AND a.nombre='Bodega';
    RAISE EXCEPTION 'NO FALLÓ: la Empleada adjusts inventario sin permiso';
EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'NO FALLÓ%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE '%inventario.ajustar%' THEN
        RAISE EXCEPTION 'falló por otra causa inesperada: %', SQLERRM;
    END IF;
    RAISE NOTICE 'OK bloqueado con SQLSTATE 42501: %', SQLERRM;
END $$;

SELECT '--- ajuste CON motivo, como ADMINISTRADORA, debe funcionar ---' AS prueba;
BEGIN;
SELECT fn_iniciar_sesion((SELECT id FROM usuarios WHERE rfc='NENR800101HDF'), '10.0.0.9');
INSERT INTO inventario_movimientos (producto_id, almacen_id, tipo, cantidad_bultos, motivo)
SELECT pr.id, a.id, 'ajuste_negativo', 3, 'Conteo físico: faltaban 3 bultos'
  FROM productos pr, almacenes a
 WHERE pr.codigo='LAC' AND a.nombre='Bodega';
COMMIT;

-- ------------------------------------------------------------------
-- 7. Auditoría de caja (saldo antes/después + usuario)
-- ------------------------------------------------------------------
BEGIN;
SELECT fn_iniciar_sesion((SELECT id FROM usuarios WHERE rfc='NENR800101HDF'), '10.0.0.5');
INSERT INTO movimientos_financieros (cuenta_id, tipo, categoria, monto, descripcion)
SELECT cf.id, 'ingreso', 'Venta', 4500.00, 'Abono en efectivo'
  FROM cuentas_financieras cf WHERE cf.nombre='Caja chica';
INSERT INTO movimientos_financieros (cuenta_id, tipo, categoria, monto, descripcion)
SELECT cf.id, 'egreso', 'Flete', 800.00, 'Flete a establo'
  FROM cuentas_financieras cf WHERE cf.nombre='Caja chica';
COMMIT;

-- ------------------------------------------------------------------
-- 7b. Corregir y borrar un movimiento de caja: los saldos deben
--     reversarse correctamente en la auditoría
-- ------------------------------------------------------------------
BEGIN;
SELECT fn_iniciar_sesion((SELECT id FROM usuarios WHERE rfc='NENR800101HDF'), '10.0.0.5');
-- Se corrige el flete de 800 a 950 (error de captura)
UPDATE movimientos_financieros
   SET monto = 950.00
 WHERE descripcion = 'Flete a establo';
-- Se borra por completo
DELETE FROM movimientos_financieros WHERE descripcion = 'Flete a establo';
COMMIT;

-- ------------------------------------------------------------------
-- 8. Auditoría de precios
-- ------------------------------------------------------------------
BEGIN;
SELECT fn_iniciar_sesion((SELECT id FROM usuarios WHERE rfc='NENR800101HDF'), '10.0.0.5');
-- vigente_desde propio: el seed ya tiene un precio vigente de hoy
INSERT INTO precios_cliente (cliente_id, producto_id, precio_kg,
                             vigente_desde, vigente_hasta)
SELECT c.id, pr.id, 8.50, DATE '2021-01-01', DATE '2021-12-31'
  FROM clientes c, productos pr
 WHERE c.codigo_cliente='CL01' AND pr.codigo='LAC';
UPDATE precios_cliente SET precio_kg = 9.25
 WHERE cliente_id = (SELECT id FROM clientes WHERE codigo_cliente='CL01');
INSERT INTO precios_publicos (producto_id, precio_kg, vigente_desde, vigente_hasta)
SELECT id, 10.00, DATE '2021-01-01', DATE '2021-12-31'
  FROM productos WHERE codigo='LAC';
COMMIT;

-- ------------------------------------------------------------------
-- 9. Accesos: login fallido y exitoso
-- ------------------------------------------------------------------
INSERT INTO auditoria_accesos (usuario_id, usuario_intento, evento, ip, detalle)
SELECT id, 'marta@ejemplo.mx', 'login_exitoso', '10.0.0.5', 'contraseña correcta'
  FROM usuarios WHERE rfc='NENR800101HDF';
INSERT INTO auditoria_accesos (usuario_intento, evento, ip, detalle)
VALUES ('desconocido@ejemplo.mx', 'login_fallido', '10.0.0.77', 'usuario inexistente');
INSERT INTO auditoria_accesos (usuario_intento, evento, ip)
VALUES ('marta@ejemplo.mx', 'login_fallido', '10.0.0.77');

-- ------------------------------------------------------------------
-- 10. Sesión
-- ------------------------------------------------------------------
INSERT INTO sesiones (usuario_id, token_hash, ip, expira_en)
SELECT id, encode(sha256('token-secreto-abc'::bytea),'hex'), '10.0.0.5',
       now() + interval '8 hours'
  FROM usuarios WHERE rfc='NENR800101HDF';

-- ------------------------------------------------------------------
-- 11. La contraseña NUNCA debe aparecer en la bitácora
-- ------------------------------------------------------------------
SELECT '--- auditoria_log: la contraseña debe estar redactada ---' AS prueba;
SELECT tabla, operacion,
       datos_nuevos->>'contrasena' AS contrasena_en_bitacora
  FROM auditoria_log
 WHERE tabla = 'usuarios' AND datos_nuevos ? 'contrasena';

SELECT '--- ¿se filtró algún hash en toda la bitácora? ---' AS prueba;
SELECT count(*) AS hashes_filtrados
  FROM auditoria_log
 WHERE datos_nuevos::text LIKE '%$2a$%'
    OR datos_anteriores::text LIKE '%$2a$%';

-- ------------------------------------------------------------------
-- 12. Reportes finales
-- ------------------------------------------------------------------
SELECT '=== BITÁCORA GENÉRICA ===' AS reporte;
SELECT fecha::timestamp(0), tabla, operacion, usuario, usuario_ip
  FROM vw_auditoria_log ORDER BY id LIMIT 12;

SELECT '=== AUDITORÍA DE CAJA ===' AS reporte;
SELECT fecha, operacion, tipo, categoria, monto, saldo_antes, saldo_despues, cuenta, usuario
  FROM vw_auditoria_caja ORDER BY id;

SELECT '=== AUDITORÍA DE INVENTARIO ===' AS reporte;
SELECT tipo, cantidad_bultos, existencia_antes, existencia_despues, motivo, producto, usuario
  FROM vw_auditoria_inventario ORDER BY id;

SELECT '=== AUDITORÍA DE PRECIOS ===' AS reporte;
SELECT tipo_precio, precio_anterior, precio_nuevo, variacion, producto, cliente, usuario
  FROM vw_auditoria_precios ORDER BY id;

SELECT '=== AUDITORÍA DE ACCESOS ===' AS reporte;
SELECT evento, usuario, host(ip) AS ip, detalle FROM vw_auditoria_accesos ORDER BY id;

SELECT '=== USUARIOS Y PERMISOS ===' AS reporte;
SELECT usuario, rfc, activo, es_dueno, roles, left(permisos, 60) AS permisos
  FROM vw_usuarios_permisos ORDER BY usuario_id;

SELECT '=== CONTEO DE TABLAS DE AUDITORÍA ===' AS reporte;
SELECT 'auditoria_log' AS tabla, count(*) FROM auditoria_log
UNION ALL SELECT 'auditoria_caja', count(*) FROM auditoria_caja
UNION ALL SELECT 'auditoria_inventario', count(*) FROM auditoria_inventario
UNION ALL SELECT 'auditoria_precios', count(*) FROM auditoria_precios
UNION ALL SELECT 'auditoria_accesos', count(*) FROM auditoria_accesos
UNION ALL SELECT 'sesiones', count(*) FROM sesiones;
