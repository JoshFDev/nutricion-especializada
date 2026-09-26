-- 0003: permisos del catalogo y unicidad sin distinguir mayusculas.
--
-- Al crear el modulo de catalogo aparecio un hueco: la tabla `permisos`
-- no tenia NINGUN codigo de especies ni de categorias, asi que no habia
-- con que autorizar esas rutas. Un permiso granular por accion es lo que
-- permite que la cajera consulte el catalogo (lo necesita para vender)
-- sin poder dar de alta especies.
--
-- Lo segundo que hace esta migracion: `especies` y `categorias_producto`
-- tienen UNIQUE(nombre) que distingue mayusculas. Eso deja meter
-- "Bovinos" y "bovinos" como dos especies distintas, y en un catalogo
-- lleno de activas eso es un descuido esperando a ocurrir. El indice por
-- lower(nombre) lo cierra. Los datos actuales no chocan (verificado
-- antes de escribir esto), asi que el indice se crea sin drama.
--
-- CONVENCION (ver backend/scripts/migrar.ts): sin BEGIN/COMMIT y sin
-- INSERT en schema_migrations. Eso es del runner.

-- ---------------------------------------------------------------- permisos
-- ON CONFLICT DO NOTHING porque esta migracion tiene que poder correr
-- mas de una vez sin quejarse (por ejemplo, sobre una base donde ya se
-- habian dado de alta a mano).
INSERT INTO pos.permisos (codigo, modulo, accion, descripcion, es_escritura) VALUES
  ('especies.ver',      'especies',   'ver',      'Ver el catalogo de especies',                  false),
  ('especies.crear',    'especies',   'crear',    'Registrar especies nuevas',                     true),
  ('especies.editar',   'especies',   'editar',   'Renombrar especies',                            true),
  ('especies.eliminar', 'especies',   'eliminar', 'Eliminar especies que no esten en uso',         true),
  ('categorias.ver',      'categorias', 'ver',      'Ver las categorias de producto',              false),
  ('categorias.crear',    'categorias', 'crear',    'Registrar categorias de producto',             true),
  ('categorias.editar',   'categorias', 'editar',   'Renombrar categorias de producto',             true),
  ('categorias.eliminar', 'categorias', 'eliminar', 'Eliminar categorias que no esten en uso',      true)
ON CONFLICT (codigo) DO NOTHING;

-- Quién lleva qué.
--   - Administrador: todo (además fn_es_admin() ya lo pasa todo).
--   - Cajera y Empleada: solo lectura. Necesitan ver el catalogo para
--     vender y registrar, pero dar de alta especies es del admin.
--   Lo mas estrecho que deja working el mostrador. Si mas adelante la
--   Empleada necesita capturar algo, se le agrega aqui su permiso.
INSERT INTO pos.roles_permisos (rol_id, permiso_id)
SELECT r.id, p.id
  FROM roles r
  CROSS JOIN permisos p
 WHERE p.codigo IN (
         'especies.ver', 'especies.crear', 'especies.editar', 'especies.eliminar',
         'categorias.ver', 'categorias.crear', 'categorias.editar', 'categorias.eliminar'
       )
   AND (
        r.nombre = 'Administrador'
     OR (r.nombre IN ('Cajera', 'Empleada') AND p.accion = 'ver')
   )
ON CONFLICT (rol_id, permiso_id) DO NOTHING;

-- --------------------------------------------------- unicidad sin mayusculas
-- lower(nombre) y no citext: es un indice, no una columna, asi que no
-- cambia el tipo de la columna ni obliga a migrar datos.
CREATE UNIQUE INDEX IF NOT EXISTS ux_especies_nombre_ci
  ON pos.especies (lower(nombre));

CREATE UNIQUE INDEX IF NOT EXISTS ux_categorias_producto_nombre_ci
  ON pos.categorias_producto (lower(nombre));

COMMENT ON INDEX pos.ux_especies_nombre_ci IS
  'Evita dos especies que solo difieren en mayusculas ("Bovino" y "bovino").';
