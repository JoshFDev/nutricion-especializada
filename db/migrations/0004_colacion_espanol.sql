-- 0004: colacion en espanol para ordenar el catalogo.
--
-- Al ordenar el catalogo de especies y categorias se quiere orden
-- spanish: "Arbol" junto a "Árbol", y "Nino" antes que "Ñandú". Con el
-- orden de bytes de PostgreSQL (C/POSIX) la Ñ se va al final de la lista
-- y las vocales acentuadas quedan aparte, que es como se ven estas tablas
-- en cada combo box de venta.
--
-- Por que una colacion ICU y no la de nombre "es-ES":
--
--   - El servidor solo tiene "es-ES" porque esa es la locale del sistema
--     operativo donde quedo instalado. En otra maquina (un contenedor, la
--     laptop del contador) puede no existir, y ORDER BY ... COLLATE
--     "es-ES" revienta con 42704 y tumba la pantalla.
--   - ICU viene DENTRO de PostgreSQL, no depende de la config regional del
--     sistema. Con ICU el mismo catalogo se ordena igual en cualquier
--     parte.
--
-- Se crea en el esquema pos, junto al resto, para que no se mezcle con las
-- collations del sistema.

-- 'es' con ICU: acentos como letra propia, Ñ despues de N, sin distinguir
-- mayusculas de minusculas.
CREATE COLLATION IF NOT EXISTS pos.es_es (provider = icu, locale = 'es');

COMMENT ON COLLATION pos.es_es IS
  'Orden en espanol para el catalogo. ICU, no depende del locale del SO. '
  'La creo la migracion 0004 porque el servidor solo tenia la de glibc.';
