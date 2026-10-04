-- El fondo que cada persona ve en la pantalla de login.
--
-- Es solo la CLAVE del fondo, no una ruta ni un nombre de archivo. La razon es
-- que este valor termina en un `background-image` del frontend, y si fuera una
-- ruta libre, escribir "/../../algo" en la propia cuenta seria una forma de
-- traerse un archivo del servidor. Guardando la clave, el backend la resuelve
-- contra la lista de `fondos-login.ts`, que es una constante del codigo: lo
-- que no esta en esa lista no existe.
--
-- NULL es una opcion valida y significa "el de por defecto". No se guarda como
-- texto vacio porque "" no seria una clave de la lista y el CHECK lo prohibe.
--
-- No se toca `activo` ni nada mas: esto es decorativo y no debe aparecer en
-- ninguna consulta de negocio, de la misma manera que el puesto.

ALTER TABLE pos.usuarios
    ADD COLUMN fondo_login TEXT;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'usuarios_fondo_login_check'
    ) THEN
        -- Las unicas claves validas son las de la constante del backend. Si
        -- mañana se agrega una imagen nueva hay que ampliar esta lista a
        -- mano, y eso es a proposito: que el conjunto de fondos se cambie con
        -- una migracion y no con un INSERT desde la aplicacion.
        ALTER TABLE pos.usuarios
            ADD CONSTRAINT usuarios_fondo_login_check
            CHECK (fondo_login IS NULL OR fondo_login IN ('vacaLengua', 'vacaFondo'));
    END IF;
END
$$;

COMMENT ON COLUMN pos.usuarios.fondo_login IS
    'Clave del fondo de la pantalla de login. NULL = el de por defecto. Se resuelve contra la lista de fondos-login.ts, nunca es una ruta.';
