-- 0002: los motivos de cierre de sesion se amplian.
--
-- Por que una migracion y no un IF NOT EXISTS en el codigo: la lista de
-- motivos es un dominio cerrado que garantiza el 0001, y el modulo de
-- usuarios necesita reasons que no existian cuando se escribio
-- (bajas de cuenta, cambios de rol, reseteo de contrasena). Que la base
-- los conozca es lo que permite que la bitacora diga por que se cerro
-- cada sesion en vez de decir "manual" para todo.
--
-- CONVENCION (ver backend/scripts/migrar.ts): este archivo NO lleva
-- BEGIN/COMMIT ni inserta en schema_migrations. De eso se encarga el
-- runner. Y no se edita un archivo ya aplicado: por eso es 0002 y no un
-- cambio sobre 0001.

-- Se suelta la constraint vieja. Todas las filas actuales tienen valores
-- del conjunto anterior, asi que el DROP no puede fallar por datos.
ALTER TABLE pos.sesiones DROP CONSTRAINT sesiones_cierre_motivo_check;

-- Se vuelve a poner con el conjunto ampliado.
ALTER TABLE pos.sesiones
  ADD CONSTRAINT sesiones_cierre_motivo_check
  CHECK (
    cierre_motivo IN (
      'logout',           -- el usuario salio por su cuenta
      'expiracion',       -- se cumplio expira_en
      'manual',           -- cambio de contrasena, o corte desde el panel
      'reinicio',         -- el servidor se reinicio
      'cuenta_desactivada',  -- el administrador dio de baja la cuenta
      'roles_actualizados',  -- cambiaron los permisos del usuario
      'contrasena_reseteada' -- el administrador le puso contrasena nueva
    )
  );

COMMENT ON COLUMN pos.sesiones.cierre_motivo IS
  'Motivo del cierre. Valores cerrados, garantizados por el CHECK. '
  'Los tres ultimos los agrega el modulo de usuarios (0002).';
