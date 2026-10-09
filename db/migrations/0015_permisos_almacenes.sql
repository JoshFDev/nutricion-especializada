-- 0015: el modulo de Almacenes.
--
-- Hasta aqui la bodega era un numero escrito a mano: el frontend de
-- compras mandaba `almacen_id: 1` siempre, y la semilla creaba una sola
-- bodega ('Bodega principal'). Si esa bodega faltaba —por ejemplo, al
-- reiniciar la base en limpio— el alta de una compra respondia "El almacen
-- 1 no existe" y no habia forma de arreglarlo desde la app: no existia
-- ninguna pantalla ni ruta para los almacenes. Este modulo es esa forma.
--
-- Los almacenes entran al CRUD generico del catalogo porque tienen la
-- misma geometria (id + nombre), y los permisos siguen el molde de 0003:
-- leer los necesita hasta la cajera, porque consultar a que bodega entra
-- la mercancia es parte de registrar la compra, y escribir es del
-- administrador.
--
-- CONVENCION (ver backend/scripts/migrar.ts): sin BEGIN/COMMIT y sin
-- INSERT en schema_migrations. Eso es del runner.

-- ---------------------------------------------------------------- permisos
INSERT INTO pos.permisos (codigo, modulo, accion, descripcion, es_escritura) VALUES
  ('almacenes.ver',      'almacenes', 'ver',      'Ver las bodegas donde entra la mercancia',           false),
  ('almacenes.crear',    'almacenes', 'crear',    'Registrar bodegas nuevas',                             true),
  ('almacenes.editar',   'almacenes', 'editar',   'Renombrar bodegas',                                    true),
  ('almacenes.eliminar', 'almacenes', 'eliminar', 'Eliminar bodegas que no hayan recibido mercancia',     true)
ON CONFLICT (codigo) DO NOTHING;

-- Quien lleva que. Mismo reparto que las especies/categorias de 0003:
--   - Administrador: todo (ademas fn_es_admin() ya lo pasa todo).
--   - Cajera y Empleada: solo lectura, para que el alta de compras (que es
--     de ambas) pueda decir a que bodega entra la mercancia.
INSERT INTO pos.roles_permisos (rol_id, permiso_id)
SELECT r.id, p.id
  FROM roles r
  CROSS JOIN permisos p
 WHERE p.codigo IN (
         'almacenes.ver', 'almacenes.crear', 'almacenes.editar', 'almacenes.eliminar'
       )
   AND (
        r.nombre = 'Administrador'
     OR (r.nombre IN ('Cajera', 'Empleada') AND p.accion = 'ver')
   )
ON CONFLICT (rol_id, permiso_id) DO NOTHING;

-- --------------------------------------------------- unicidad sin mayusculas
-- Misma red que 0003: "Bodega BUAP" y "bodega buap" son LA MISMA bodega,
-- y un catalogo que las deje dos veces acaba mandando mercancia a una
-- copia fantasmas. lower(nombre), no citext: un indice, no un cambio de
-- tipo de columna.
CREATE UNIQUE INDEX IF NOT EXISTS ux_almacenes_nombre_ci
  ON pos.almacenes (lower(nombre));

COMMENT ON INDEX pos.ux_almacenes_nombre_ci IS
  'Evita dos bodegas que solo difieren en mayusculas ("Bodega BUAP" y "bodega buap").';