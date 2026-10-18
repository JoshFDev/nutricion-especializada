-- El codigo de un solo uso con el que se da de baja definitiva una cuenta.
--
-- Para que: eliminar un usuario es irreversible (la fila desaparece y todas
-- las referencias historicas quedan sin el). El administrador no lo puede
-- hacer en un clic por error: el sistema le manda un codigo al CORREO del
-- empleado y el administrador tiene que teclearlo. Asi la baja necesita que
-- las dos partes esten de acuerdo, y el codigo solo lo ve el empleado.
--
-- Un renglon por usuario (PK usuario_id): pedir un codigo nuevo reemplaza al
-- anterior en vez de acumular basura. El ON DELETE CASCADE es a proposito:
-- cuando la cuenta se borra, este renglon se va con ella y no deja un codigo
-- huerfano apuntando a un id que ya no existe.
--
-- El codigo NO se guarda en claro, se guarda con crypt() igual que la
-- contrasena. Es un secreto de un solo uso; si alguien lee la tabla no tiene
-- que poder usarlo. `expira_en` es la hora limite y `intentos` cuenta los
-- fallos para cortar a quien este adivinando (6 digitos son pocos).
--
-- No lleva trigger de permisos ni de auditoria: no es una tabla de negocio,
-- la toca solo este flujo y su contenido es de un solo uso. La baja del
-- usuario SI queda auditada (trg_usuarios_auditoria ya existe).

CREATE TABLE IF NOT EXISTS pos.usuarios_codigo_baja (
    usuario_id  BIGINT PRIMARY KEY REFERENCES pos.usuarios(id) ON DELETE CASCADE,
    codigo_hash TEXT        NOT NULL,
    expira_en   TIMESTAMPTZ NOT NULL,
    intentos    SMALLINT    NOT NULL DEFAULT 0 CHECK (intentos >= 0),
    creado_en   TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE pos.usuarios_codigo_baja IS
    'Codigo de verificacion de un solo uso para eliminar una cuenta. Lo manda el sistema al correo del empleado y lo teclea el administrador.';
