-- 0016: el modulo de Reportes.
--
-- CONTEXTO. 0001 dejo tres vistas listas para reportes y nunca se expuso
-- ninguna: `vw_existencia_actual` (lo que hay en cada bodega),
-- `vw_consumo_semanal_promedio` (los kilos que consume cada cliente por
-- producto) y `vw_estado_cuenta_cliente` (cuanto debe cada quien). Son las
-- hojas que hoy se llevan a mano en Excel, y hasta aqui el sistema las
-- calculaba por dentro sin dar acceso a ninguna: el dato estaba y no se podia
-- ver.
--
-- El permiso es UNO solo, `reportes.ver`, y no uno por vista. Las tres son de
-- SOLO LECTURA y ninguna expone precios (el costo y las listas de precio
-- quedan fuera de estas vistas a proposito), asi que separarlas no protegia
-- nada: solo daria tres permisos que se conceden siempre juntos. Si alguna vez
-- una vista pasa a traer margen, ahi si se parte.
--
-- Quien lo lleva. Es lectura del negocio entero, asi que va con los tres
-- roles: la Administradora para ver todo, la Empleada porque la existencia es
-- parte de su dia, y la Cajera porque el estado de cuenta es exactamente su
-- trabajo de cobranza. Ninguna de las tres vistas tiene una columna que alguna
-- de ellas no pudiera ver hoy en su propia pantalla.
--
-- CONVENCION (ver backend/scripts/migrar.ts): sin BEGIN/COMMIT y sin
-- INSERT en schema_migrations. Eso es del runner.

-- ---------------------------------------------------------------- permiso
INSERT INTO pos.permisos (codigo, modulo, accion, descripcion, es_escritura) VALUES
  ('reportes.ver', 'reportes', 'ver', 'Ver los reportes del negocio: existencia, consumo y estado de cuenta', false)
ON CONFLICT (codigo) DO NOTHING;

-- El reparto. Mismo molde que 0003 y 0015: Administrador todo, y los otros
-- dos roles solo la lectura.
INSERT INTO pos.roles_permisos (rol_id, permiso_id)
SELECT r.id, p.id
  FROM roles r
  CROSS JOIN permisos p
 WHERE p.codigo = 'reportes.ver'
   AND (
        r.nombre = 'Administrador'
     OR r.nombre IN ('Empleada', 'Cajera')
   )
ON CONFLICT (rol_id, permiso_id) DO NOTHING;
