-- 0005: unicidad del codigo de producto sin distinguir mayusculas, y
-- presentacion positiva.
--
-- Al exponer /api/productos aparecieron dos huecos que la tabla dejo
-- abiertos desde 0001:
--
-- 1. `productos.codigo` tiene UNIQUE que DISTINGUE mayusculas. El catalogo
--    de productos se maneja con codigos cortos de tres o cuatro letras
--    ('LAC', 'MBE', 'MTO'), que es exactamente el tipo de dato que alguien
--    teclea en mayusculas un dia y en minusculas otro. Con el UNIQUE de
--    0001 se podian dar de alta 'LAC' y 'lac' como dos productos
--    distintos, y el que los captura es el que se lleva el 409 cuando
--    intenta corregirlo. El indice por lower(codigo) lo cierra, igual que
--    hizo 0003 con los nombres del catalogo.
--
--    No se normaliza a mayusculas en la base a proposito: el codigo es un
--    identificador, no texto de pantalla, y guardarlo tal cual evita que
--    dos caminhos distintos del codigo disagrees sobre como escribirlo.
--    La unicidad sin mayusculas es lo que protege el dato; que se vea
--    prolijo es cosa del formulario.
--
-- 2. `presentacion_kg` es NOT NULL pero admitia 0 y negativos. Un producto
--    de 0 kg por bulto no significa nada, y con el CHECK la base lo
--    rechaza aunque algun camino futuro se olvide de validarlo en Zod.
--
-- Los datos actuales no chocan con ninguno de los dos (verificado antes
-- de escribir esto: codigos LAC, DHP y MTO, todos distintos en lower(), y
-- presentaciones de 20, 25 y 5 kg), asi que los dos se crean sin drama.
--
-- CONVENCION (ver backend/scripts/migrar.ts): sin BEGIN/COMMIT y sin
-- INSERT en schema_migrations. Eso es del runner.

-- ------------------------------------------- unicidad sin distinguir mayusculas
-- lower(codigo) y no citext: es un indice, no una columna, asi que no
-- cambia el tipo de la columna ni obliga a migrar datos.
CREATE UNIQUE INDEX IF NOT EXISTS ux_productos_codigo_ci
  ON pos.productos (lower(codigo));

COMMENT ON INDEX pos.ux_productos_codigo_ci IS
  'Evita dos productos con el mismo codigo ignorando mayusculas ("LAC" y "lac").';

-- ------------------------------------------------------- presentacion positiva
ALTER TABLE pos.productos
  DROP CONSTRAINT IF EXISTS chk_productos_presentacion_positiva;

ALTER TABLE pos.productos
  ADD CONSTRAINT chk_productos_presentacion_positiva
  CHECK (presentacion_kg > 0);

COMMENT ON CONSTRAINT chk_productos_presentacion_positiva ON pos.productos IS
  'Los kg por bulto tienen que ser mayores que cero: un producto de 0 kg no significa nada.';
