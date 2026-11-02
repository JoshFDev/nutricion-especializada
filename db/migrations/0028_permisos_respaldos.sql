-- 0028: permiso para la pantalla de respaldos.
--
-- CONTEXTO. Los respaldos viven en la aplicacion de escritorio (proceso
-- principal de Electron), no en la API: es el unico que puede leer el
-- archivo y reiniciar la aplicacion despues de restaurar. Pero la pantalla
-- que los administra si es parte del sistema, y necesita un permiso como
-- cualquier otro modulo.
--
-- Se agregan DOS permisos y no uno:
--
--   `respaldos.ver`        abre la pantalla y deja ver que respaldos hay.
--   `respaldos.gestionar`  permite crear y restaurar. Restaurar reemplaza
--                          TODA la base, asi que no es una accion de
--                          lectura ni algo que deba poder hacer cualquiera
--                          que solo necesita consultar.
--
-- El menu usa `respaldos.ver` (igual que todos los modulos), y la pantalla
-- esconde los botones si falta `respaldos.gestionar`.
--
-- CONVENCION (ver backend/scripts/migrar.ts): sin BEGIN/COMMIT y sin
-- INSERT en schema_migrations. Eso es del runner.

INSERT INTO pos.permisos (codigo, modulo, accion, descripcion, es_escritura) VALUES
  ('respaldos.ver',       'respaldos', 'ver',       'Ver los respaldos del sistema',              FALSE),
  ('respaldos.gestionar', 'respaldos', 'gestionar', 'Crear respaldos y restaurar la base de datos', TRUE)
ON CONFLICT (codigo) DO NOTHING;

-- Los roles administradores reciben los dos permisos. No se reparten a
-- Empleada ni a Cajera: un respaldo contiene toda la operacion del negocio,
-- y restaurarlo borra lo que se haya capturado despues de la fecha del
-- archivo.
INSERT INTO pos.roles_permisos (rol_id, permiso_id)
SELECT r.id, p.id
  FROM pos.roles r
 CROSS JOIN pos.permisos p
 WHERE r.es_admin
   AND p.codigo IN ('respaldos.ver', 'respaldos.gestionar')
ON CONFLICT DO NOTHING;
