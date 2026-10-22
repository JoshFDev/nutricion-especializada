-- 0025: los roles dejan de ser un dominio cerrado.
--
-- CONTEXTO. `roles.nombre` tenia un CHECK que solo admitia tres nombres:
-- 'Administrador', 'Empleada' y 'Cajera'. Los tres vienen del seed, con sus
-- permisos ya decididos, y el sistema funciona con ellos.
--
-- El problema es que el CHECK decia "estos tres y ningun mas" en el sitio
-- donde de verdad se decide que puede hacer cada quien: la tabla de roles.
-- Cada vez que se quisiera un rol nuevo (un "Encargado de compras" que
-- vea las compras pero no la caja, un "Contador" que solo vea el estado de
-- cuenta), habia que ir a la base con un INSERT.
--
-- Y el `es_admin` tampoco era un flag de verdad: `fn_es_admin()` buscaba el
-- rol por NOMBRE ("Administrador"), asi que un rol nuevo con `es_admin = TRUE`
-- no era administrador, por mas que la columna dijera que si.
--
-- QUE HACE ESTA MIGRACION
--
-- 1. Se suelta el CHECK de los tres nombres. Los roles siguen siendo UN
--    dominio cerrado en la practica (el seed pone tres, y no hay pantalla
--    para crear mas), pero la base ya no lo prohibe.
--
-- 2. `fn_es_admin()` mira el FLAG `roles.es_admin` en vez del nombre. El
--    rol 'Administrador' del seed ya lo tiene en TRUE, asi que para el
--    sistema actual no cambia nada; lo que cambia es que un rol con
--    `es_admin = TRUE` cuenta como administrador de verdad, que es lo que
--    la columna dice.
--
--    `fn_tiene_rol()` se queda como esta: es una pregunta por NOMBRE, y
--    tiene sentido que lo sea.
--
-- NOTA. Esto NO agrega una pantalla de administracion de roles: eso es una
-- funcion, no un arreglo. Lo que hace es que el modelo de la base sea
-- honesto (el flag manda, no el nombre) y que agregar un rol sea un
-- INSERT, como los que hizo el seed.
--
-- CONVENCION (ver backend/scripts/migrar.ts): sin BEGIN/COMMIT y sin
-- INSERT en schema_migrations. Eso es del runner.

-- ------------------------------------------------------------------ 1
--
-- Se suelta el CHECK de los tres nombres.
ALTER TABLE pos.roles DROP CONSTRAINT IF EXISTS roles_nombre_check;

COMMENT ON TABLE pos.roles IS
    'Los roles del negocio. El seed deja tres (Administrador, Empleada, Cajera) con sus permisos decididos. Se pueden agregar mas: lo que no deja es cambiar el nombre de los tres, porque el seed los busca por nombre.';

-- ------------------------------------------------------------------ 2
--
-- El flag manda, no el nombre.
--
-- `fn_es_admin()` es lo que decide si alguien se salta las validaciones de
-- permisos, asi que tiene que leer la columna que dice "soy administrador".
-- Antes leia el nombre del rol, y por eso un rol nuevo con `es_admin` en
-- TRUE no era administrador.
CREATE OR REPLACE FUNCTION pos.fn_es_admin()
RETURNS BOOLEAN AS $$
    SELECT EXISTS (
        SELECT 1
          FROM usuarios_roles ur
          JOIN roles r ON r.id = ur.rol_id
         WHERE ur.usuario_id = pos.fn_usuario_actual()
           AND r.es_admin
    )
    OR EXISTS (
        SELECT 1 FROM usuarios u
         WHERE u.id = pos.fn_usuario_actual() AND u.es_dueno AND u.activo
    );
$$ LANGUAGE sql STABLE;

COMMENT ON FUNCTION pos.fn_es_admin() IS
    'Si el usuario actual es administrador: tiene un rol con es_admin = TRUE, o es la dueña. El rol Administrador del seed lo tiene en TRUE.';
