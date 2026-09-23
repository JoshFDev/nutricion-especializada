-- Datos de ejemplo para probar el sistema sin usar info real de clientes.
-- Correr DESPUÉS de 0001_init.sql
SET search_path TO pos, public;

INSERT INTO especies (nombre) VALUES ('Bovinos lecheros'), ('Ovinos'), ('Porcinos');
INSERT INTO almacenes (nombre) VALUES ('Bodega principal');

INSERT INTO productos (codigo, nombre, especie_id, presentacion_kg)
VALUES ('LAC', 'VIMILAC 400', 1, 20),
       ('DHP', 'DHP-22', 1, 25);

INSERT INTO clientes (codigo_cliente, nombre, especie_id, estatus)
VALUES ('CL01', 'Cliente de prueba', 1, 'Activo');

INSERT INTO folios (folio_numero) VALUES (1001), (1002), (1003);
