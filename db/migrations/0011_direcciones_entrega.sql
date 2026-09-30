-- 0011: el catalogo de direcciones de entrega de la sucursal.
--
-- CONTEXTO. `notas_remision.direccion_entrega` es un TEXT libre (0001) y el
-- mostrador lo pide en cada nota. Escribiendo la direccion completa cada
-- vez se cometieron dos errores que no tienen vuelta atras:
--
--   - La misma direccion escrita de dos maneras distintas ("Carretera a
--     Cholula km 12" y "km 12 carretera a cholula"). El papel sale con una de
--     las dos y el chofer no sabe cual.
--   - La direccion equivocada en la nota que mas falta hacia, porque el que
--    .capture la nota no es el que sabe a donde va el camion.
--
-- Esta tabla es la lista de destinos de la SUCURSAL, no de los clientes. Es
-- una diferencia de fondo y no de forma: una direccion es un lugar fisico al
-- que la sucursal lleva la mercancia, y el mismo rancho lo compra el cliente
-- de siempre y el que va a deber la cuenta. Atarla al cliente convertia el
-- dato en "direccion de Don Chema", que es justo lo que hay que evitar: la
-- direccion la elige quien carga, no quien compra.
--
-- POR QUE LA NOTA GUARDA EL TEXTO Y NO EL ID. `notas_remision` ya tiene
-- `direccion_entrega TEXT` y NO se le agrega una FK a esta tabla, a proposito:
-- la nota es un documento y el documento dice a donde se llevo la mercancia
-- el dia que se emitio. Si la nota apuntara al id, renombrar la direccion o
-- borrarla del catalogo cambiaria (o dejaria sin destino) notas ya
-- entregadas, y el papel que ya salio no se corrige despues. Con el texto
-- copiado, la nota dice lo que decia ayer y el catalogo se puede limpiar sin
-- tocar ningun documento.
--
-- `nombre` es la etiqueta corta con la que la persona la reconoce ("Rancho
-- Los Gomez", "Bodega de Chema"), y `direccion` el texto que se imprime. Sin
-- el nombre, una lista de direcciones largas se distingue entre si
-- comparandolas letra por letra, que es justo lo que hay que evitar en un
-- mostrador.
--
-- CONVENCION (ver backend/scripts/migrar.ts): sin BEGIN/COMMIT y sin
-- INSERT en schema_migrations. Eso es del runner.

-- --------------------------------------------------------------- la tabla
--
-- SMALLSERIAL y no BIGSERIAL como en las tablas de negocio: esta lista tiene
-- unas decenas de filas, no millones, y el tope de 32767 de SMALLINT hace que
-- un id disparado a mano se rechace en el esquema con un mensaje claro en vez
-- de reventar en Postgres con un 22003 (mismo criterio que `especies`).
CREATE TABLE IF NOT EXISTS pos.direcciones_entrega (
    id          SMALLSERIAL PRIMARY KEY,
    nombre      TEXT NOT NULL CHECK (btrim(nombre) <> ''),
    direccion   TEXT NOT NULL CHECK (btrim(direccion) <> ''),
    creado_en   TIMESTAMP NOT NULL DEFAULT now(),
    actualizado_en TIMESTAMP NOT NULL DEFAULT now()
);

COMMENT ON TABLE pos.direcciones_entrega IS
  'Destinos de entrega de la sucursal. Es de la sucursal y no de los clientes: la elige quien captura la nota.';
COMMENT ON COLUMN pos.direcciones_entrega.nombre IS
  'Etiqueta corta con la que se reconoce el destino. Ej. "Rancho Los Gomez".';
COMMENT ON COLUMN pos.direcciones_entrega.direccion IS
  'El texto que se imprime en el papel. Es el que se copia a notas_remision.direccion_entrega.';

-- El `btrim` de los CHECK no alcanza para que no haya duplicados: "Rancho
-- Los Gomez" y "rancho los gomez" son el mismo destino escritos distinto, y
-- en una lista que se elige a mano aparecen las dos y la persona no sabe
-- cual es la buena. El indice es por lower(), igual que en 0003 para
-- especies y categorias, y la diferencia con un UNIQUE de columna es que no
-- cambia el tipo de la columna.
--
-- El indice va sobre `nombre`, no sobre `direccion`: el nombre es lo que se
-- teclea para encontrar el destino ("Gomez"), y la direccion es el texto largo
-- que puede diferir en una coma sin que sea otro lugar.
CREATE UNIQUE INDEX IF NOT EXISTS ux_direcciones_entrega_nombre_ci
  ON pos.direcciones_entrega (lower(nombre));

COMMENT ON INDEX pos.ux_direcciones_entrega_nombre_ci IS
  'Evita dos destinos que solo difieren en mayusculas o espacios ("Gomez" y "gomez").';

CREATE TRIGGER trg_direcciones_updated
    BEFORE UPDATE ON pos.direcciones_entrega
    FOR EACH ROW EXECUTE FUNCTION pos.fn_set_actualizado_en();

-- ---------------------------------------------------------------- permisos
--
-- Granulares como los del catalogo (0003) y no permiso unico: elegir una
-- direccion para la nota es de las cosas que mas hace la cajera, y borrar
-- una direccion del catalogo es de las que casi nadie tiene que hacer.
--
-- NOTA SOBRE EL TRIGGER DE PERMISOS: esta tabla NO lleva `fn_trg_permiso`, y
-- es a proposito, igual que especies y categorias_producto. Ese trigger se
-- puso en las tablas donde un UPDATE escrito a mano en psql mueve dinero o
-- inventario (clientes, notas, pagos, precios, compras, inventario, usuarios,
-- caja). Aqui lo que se modifica es una lista de destinos: el mismo texto
-- que la persona escribe en el campo de la nota, nada mas que guardado para
-- no escribirlo otra vez. Autorizarlo en la ruta es suficiente y deja la
-- tabla como esta en las otras cuatro que tampoco son de dinero.
INSERT INTO pos.permisos (codigo, modulo, accion, descripcion, es_escritura) VALUES
  ('direcciones.ver',      'direcciones', 'ver',      'Ver el catalogo de direcciones de entrega', false),
  ('direcciones.crear',    'direcciones', 'crear',    'Guardar direcciones de entrega en el catalogo', true),
  ('direcciones.editar',   'direcciones', 'editar',   'Cambiar el nombre o el texto de una direccion', true),
  ('direcciones.eliminar', 'direcciones', 'eliminar', 'Borrar direcciones que ya no se usan',        true)
ON CONFLICT (codigo) DO NOTHING;

-- Quién lleva qué.
--   - Administrador: todo.
--   - Cajera: todo tambien, porque es la que captura las notas y es la que
--     sabe cuando una direccion cambio de nombre o ya no aplica. Dejarle solo
--     lectura significaba que cada direccion mal capturada se quedara para
--     siempre sin poder arreglarse desde la app.
--   - Empleada: ver y crear. Puede elegir una direccion y agregar una nueva,
--     pero no tocar ni borrar las que ya estan: son destinos que conoce el
--     turno, no la capturadora.
INSERT INTO pos.roles_permisos (rol_id, permiso_id)
SELECT r.id, p.id
  FROM roles r
  CROSS JOIN permisos p
 WHERE p.codigo IN ('direcciones.ver', 'direcciones.crear', 'direcciones.editar', 'direcciones.eliminar')
   AND r.nombre IN ('Administrador', 'Cajera', 'Empleada')
   AND NOT (r.nombre = 'Empleada' AND p.accion IN ('editar', 'eliminar'))
ON CONFLICT (rol_id, permiso_id) DO NOTHING;
