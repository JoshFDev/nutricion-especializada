-- 0006: la cajera queda casi tan habilitada como el administrador.
--
-- CONTEXTO. La reparticion original venia de 0001 y era la de un negocio
-- donde la cajera solo cobra: tenia 10 de los 43 permisos, casi todos de
-- lectura. El duenio decidio que en la practica la cajera hace mucho mas
-- que cobrar -- captura, ve facturas, esta en el mostrador -- y que dejarla
-- tan recortada solo genera que le pido un favor a alguien con mas
-- permisos o que se inventen rodeos por la base de datos.
--
-- QUE SE HACE. Se le concede todo menos cinco cosas, que son las que de
-- verdad conviene que no salgan de la oficina:
--
--   usuarios.crear, usuarios.editar, usuarios.ver  -- dar de alta cuentas
--   auditoria.accesos                             -- quien entro y a que
--   inventario.ajustar                            -- correcciones de stock
--
-- "inventario.ajustar" es la exclusion mas importante de las tres. Ajustar
-- inventario mueve plata: si el fisico no coincide con el sistema, alguien
-- tiene que escribir cual de los dos esta bien, y desde ahi se puede
-- inventar mercancia que no existe. Que lo haga el administrador.
--
-- NOTA SOBRE usuarios.*: concederlos NO basta. Las cuatro rutas de
-- /api/usuarios estaban proteger por `requiereAdmin`, que pregunta por el
-- ROL con fn_es_admin() y no por el permiso. Conceder usuarios.ver sin
-- tocar ese middleware deja un permiso concedido que no abre ninguna
-- puerta, que es peor que no concederlo: parece que funciona y no
-- funciona. Por eso esta migracion va acompanada de un cambio de codigo
-- que pasa esas rutas a permiso granular.
--
-- ON CONFLICT DO NOTHING porque esta migracion tiene que poder correr mas
-- de una vez sin quejarse. Los permisos que la cajera ya tenia se crean
-- de nuevo aqui a proposito: es la lista completa, no una.delta, asi que
-- volver a correrla repara una base a la que le falte alguno.
--
-- CONVENCION (ver backend/scripts/migrar.ts): sin BEGIN/COMMIT y sin
-- INSERT en schema_migrations. Eso es del runner.

-- ------------------------------------------------------------------ cajera
-- Todo lo que existe menos las cinco exclusiones de arriba. Se escribe
-- como "todo MENOS unas cuantas" y no como una lista de 38, para que el
-- proximo permiso que se agregue a la tabla entre solo, sin que alguien
-- tenga que acordarse de volver a correr esta migracion.
INSERT INTO pos.roles_permisos (rol_id, permiso_id)
SELECT r.id, p.id
  FROM pos.roles r
  CROSS JOIN pos.permisos p
 WHERE r.nombre = 'Cajera'
   AND p.codigo NOT IN (
     'usuarios.crear',
     'usuarios.editar',
     'usuarios.ver',
     'auditoria.accesos',
     'inventario.ajustar'
   )
ON CONFLICT (rol_id, permiso_id) DO NOTHING;

-- ------------------------------------------------------- invariante
-- Esta migracion no REVOCA nada, asi que el invariante importante es el
-- de al lado: que nadie quede con usuarios.editar y sin usuarios.ver.
--
-- Ese estado parece posible y no lo es desde la aplicacion. El modulo de
-- usuarios concede editar, listar, cambiar roles y resetear contrasena, y
-- las cuatro rutas que.Admin tiene mapeadas a usuarios.*. Si a un rol se
-- le quita usuarios.ver y se le deja usuarios.editar, ese rol puede
-- editar una cuenta sin poder ni abrir la pantalla donde se listan, y no
-- hay forma de arreglarlo desde la UI: hay que entrar a la base.
--
-- Se comprueba al final y no en un trigger porque la migracion no quita
-- permisos: es una red de seguridad para cuando alguien escriba aqui a
-- mano un DELETE que si los quita.
DO $$
DECLARE
  huerfanos integer;
BEGIN
  -- EXISTS y no un par de JOIN: hacer JOIN de roles_permisos sin
  -- filtrar por permiso multiplica la fila del rol por cuantos permisos
  -- tenga, y el contador acaba reportando 42 huerfanos en un rol que si
  -- tiene usuarios.ver. Se revisa rol por rol con dos preguntas directas.
  SELECT count(*) INTO huerfanos
    FROM pos.roles r
   WHERE EXISTS (
           SELECT 1
             FROM pos.roles_permisos rp
             JOIN pos.permisos p ON p.id = rp.permiso_id
            WHERE rp.rol_id = r.id
              AND p.codigo = 'usuarios.editar'
         )
     AND NOT EXISTS (
           SELECT 1
             FROM pos.roles_permisos rp
             JOIN pos.permisos p ON p.id = rp.permiso_id
            WHERE rp.rol_id = r.id
              AND p.codigo = 'usuarios.ver'
         );

  IF huerfanos > 0 THEN
    RAISE EXCEPTION
      'Hay % rol(es) con usuarios.editar pero sin usuarios.ver', huerfanos;
  END IF;
END
$$;
