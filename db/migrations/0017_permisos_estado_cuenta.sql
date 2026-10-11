-- 0017: el modulo de Estado de cuenta.
--
-- CONTEXTO. Hasta aqui la cobranza se apoyaba en dos cosas que no cerraban:
-- el reporte de `reportes.ver`, que dice cuanto debe cada cliente pero no deja
-- sacar la hoja de UNO, y la pantalla de Facturacion, que era lo que colgaba
-- en el grupo Dinero del menu y no tiene que ver con cobrar. El modulo nuevo
-- hace las dos cosas que faltaban: lista a los clientes con su saldo y deja
-- bajar la hoja de estado de cuenta de cada uno como Excel, con la misma
-- plantilla que el negocio ya usaba a mano.
--
-- POR QUE UN PERMISO APARTE Y NO `reportes.ver`. Aunque las dos cosas lean de
-- la misma vista `vw_estado_cuenta_cliente`, no son la misma operacion: el
-- reporte es una foto de conjunto para quien mira el negocio, y esta pantalla
-- es la herramienta de cobranza del dia, con una descarga por cliente. Quien
-- administra puede querer dar la segunda sin la primera (la cajera que no debe
-- ver los margenes del reporte de consumo), y ese caso es justo el que un
-- permiso unico no deja expresar. Es el mismo criterio con el que 0003 separo
-- el catalogo de precios.
--
-- Quien lo lleva. Mismo reparto que `facturas.ver`, que es el permiso al que
-- este modulo sustituye en el menu: los tres roles. La Administradora para
-- cobrar y revisar, la Empleada porque la cuenta es parte de su mostrador, y
-- la Cajera porque el estado de cuenta ES su trabajo de cobranza. Es de solo
-- lectura y no trae precios ni costos: la vista ya los deja fuera a proposito.
--
-- CONVENCION (ver backend/scripts/migrar.ts): sin BEGIN/COMMIT y sin
-- INSERT en schema_migrations. Eso es del runner.

-- ---------------------------------------------------------------- permiso
--
-- El codigo lleva guion BAJO, no guion medio: `permisos.codigo` tiene el CHECK
-- `^[a-z_]+\.[a-z_]+$`, que no admite `-`. El nombre del modulo en la carpeta y
-- en la URL si usa `estado-cuenta`, pero el permiso es un identificador de la
-- base, con su propio alfabeto.
INSERT INTO pos.permisos (codigo, modulo, accion, descripcion, es_escritura) VALUES
  ('estado_cuenta.ver', 'estado_cuenta', 'ver', 'Ver el estado de cuenta por cliente y bajar su hoja en Excel', false)
ON CONFLICT (codigo) DO NOTHING;

-- El reparto. Mismo molde que 0003, 0015 y 0016: Administrador todo, y los
-- otros dos roles solo la lectura.
INSERT INTO pos.roles_permisos (rol_id, permiso_id)
SELECT r.id, p.id
  FROM roles r
  CROSS JOIN permisos p
 WHERE p.codigo = 'estado_cuenta.ver'
   AND r.nombre IN ('Administrador', 'Empleada', 'Cajera')
ON CONFLICT (rol_id, permiso_id) DO NOTHING;
