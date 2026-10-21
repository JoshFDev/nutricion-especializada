-- 0021: cambiar la PROPIA contraseña no exige el permiso usuarios.editar.
--
-- CONTEXTO. El trigger `trg_permiso_usuarios` (0001) pide `usuarios.editar`
-- para CUALQUIER UPDATE sobre `usuarios`. Eso incluye los tres casos de
-- siempre (editar la cuenta de otro, cambiarle los roles, resetearle la
-- clave) y tambien uno que no es de administrar cuentas:
--
--   - La persona entra con la contraseña temporal (la del alta, la del
--     reseteo o la de "recuperar contraseña"), el sistema la obliga a
--     cambiarla y lo hace con POST /api/auth/cambiar-contrasena. Esa ruta
--     pide sesion viva y la contraseña ACTUAL: no pide usuarios.editar, y
--     a proposito, porque cambiar tu propia clave no es editar la cuenta
--     de OTRO.
--
--   - El fallo era que la base de datos si lo pedia. La cuenta que llega
--     por recuperacion es una cuenta normal (Cajera, Empleada) y no tiene
--     usuarios.editar, asi que el UPDATE rebotaba con SQLSTATE 42501 y
--     el mensaje "El usuario 5 no tiene el permiso usuarios.editar". La
--     persona se quedaba atrapada en la pantalla de "Cambia tu contraseña"
--     sin poder salir de ahi: el unico camino era que el administrador le
--     pusiera la clave a mano.
--
-- POR QUE SE ARREGLA EN LA BASE Y NO EN EL CODIGO. El trigger es la ultima
-- linea de defensa: si la excepcion viviera en TypeScript, un UPDATE
-- escrito a mano en psql volveria a poder cambiar la clave de cualquiera.
-- La excepcion se mete en la misma puerta que la prohibe, y es la MAS
-- ESTRECHA que se puede:
--
--   1) Solo la fila del propio usuario (NEW.id = usuario de la sesion).
--   2) Solo si la contraseña cambia de verdad en ese UPDATE.
--   3) Solo si no se toca NADA mas que los campos de la contraseña
--      (contrasena, debe_cambiar_contrasena, intentos_fallidos,
--      bloqueado_hasta y actualizado_en).
--
-- Con esas tres condiciones, `activo`, `es_dueno`, `email`, `rfc` y el resto
-- de la cuenta siguen exigiendo usuarios.editar, y una fila que no es la
-- propia tambien. Lo que se abre es exactamente lo que ya se permitia en
-- la aplicacion: tu propia clave.
--
-- NOTA. `intentos_fallidos` y `bloqueado_hasta` entran en la lista porque el
-- cambio de contraseña los limpia (quien la cambia demonstro que es el
-- dueño de la cuenta). No son una concesion: la excepcion exige que la
-- contraseña cambie EN EL MISMO UPDATE, asi que con una sesion viva no se
-- pueden limpiar los contadores de una cuenta ajena ni los de la propia
-- sin cambiar la clave.
--
-- CONVENCION (ver backend/scripts/migrar.ts): sin BEGIN/COMMIT y sin
-- INSERT en schema_migrations. Eso es del runner.

-- ------------------------------------------------------------------ helper
--
-- Es una funcion normal y no un trigger porque tiene que poder PROBARSE
-- sola, sin meter una sesion de verdad: recibe las dos versiones de la
-- fila en JSONB y contesta si el cambio es el permitido.
--
-- Las columnas se comparan como JSONB y no campo por campo porque la
-- fila completa de `usuarios` tiene veinte columnas y esta lista tiene que
-- decir QUE SE PUEDE TOCAR, no cual se prohibe: las columnas que se
-- agreguen mañana van a quedar cubiertas solas.
CREATE OR REPLACE FUNCTION pos.fn_cambio_contrasena_propio(
    p_usuario_actual BIGINT,
    p_nuevo          JSONB,
    p_anterior       JSONB
) RETURNS BOOLEAN AS $$
BEGIN
    -- Sin sesion no hay nadie a quien se le conceda nada: aqui no hay
    -- excepcion que valga y el trigger sigue exigiendo el permiso.
    IF p_usuario_actual IS NULL THEN
        RETURN FALSE;
    END IF;

    -- 1) Su propia fila y no la de otro. Se comparan como texto para no
    --    castear el id (un id no numerico reventaria la funcion).
    IF (p_nuevo ->> 'id') IS DISTINCT FROM p_usuario_actual::TEXT THEN
        RETURN FALSE;
    END IF;

    -- 2) Y solo si la contraseña cambia de verdad. Con esto, limpiar los
    --    contadores de intentos sin cambiar la clave NO cuenta como cambio
    --    de contraseña.
    IF (p_nuevo ->> 'contrasena') IS NOT DISTINCT FROM (p_anterior ->> 'contrasena') THEN
        RETURN FALSE;
    END IF;

    -- 3) Y sin tocar nada mas. Se quitan de las dos versiones los campos
    --    de la contraseña y lo que queda tiene que ser EXACTAMENTE lo
    --    mismo: si cambia aunque sea un campo mas (activo, es_dueno,
    --    email, rfc, puesto...), la excepcion no aplica y el trigger
    --    vuelve a pedir usuarios.editar.
    RETURN (p_nuevo
                - 'contrasena' - 'debe_cambiar_contrasena'
                - 'intentos_fallidos' - 'bloqueado_hasta' - 'actualizado_en')
        IS NOT DISTINCT FROM
           (p_anterior
                - 'contrasena' - 'debe_cambiar_contrasena'
                - 'intentos_fallidos' - 'bloqueado_hasta' - 'actualizado_en');
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION pos.fn_cambio_contrasena_propio(BIGINT, JSONB, JSONB) IS
    'Verdadero si el UPDATE es el cambio de la PROPIA contraseña: misma fila, '
    'contraseña distinta y nada mas tocado. Lo usa fn_trg_permiso para no '
    'exigir usuarios.editar en ese caso.';

-- ------------------------------------------------------- trigger de permiso
--
-- Se vuelve a definir la MISMA funcion de 0001 con una excepcion mas. Va
-- entera, no un parche: `CREATE OR REPLACE` reemplaza el cuerpo, asi que
-- dejar fuera una rama seria perderla.
CREATE OR REPLACE FUNCTION pos.fn_trg_permiso()
RETURNS TRIGGER AS $$
DECLARE
    v_insert TEXT := TG_ARGV[0];
    v_update TEXT := COALESCE(NULLIF(TG_ARGV[1], ''), TG_ARGV[0]);
    v_delete TEXT := COALESCE(NULLIF(TG_ARGV[2], ''), TG_ARGV[0]);
BEGIN
    -- OJO: en un trigger BEFORE hay que devolver NEW/OLD. Devolver NULL
    -- cancela la operación EN SILENCIO (el INSERT simplemente no ocurre).
    IF fn_usuario_actual() IS NULL THEN
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
    END IF;

    -- Movimientos de inventario generados por el sistema: sin control de
    -- permisos (vender no debería requerir un permiso de inventario).
    IF TG_TABLE_NAME = 'inventario_movimientos' THEN
        IF COALESCE(NEW.referencia_tabla, OLD.referencia_tabla) IS NOT NULL THEN
            IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
            RETURN NEW;
        END IF;
    END IF;

    IF TG_OP = 'INSERT' THEN
        PERFORM fn_exigir_permiso(v_insert);
    ELSIF TG_OP = 'UPDATE' THEN
        -- Excepción del 2026: cambiar la PROPIA contraseña no es editar la
        -- cuenta de otro, y no puede pedir `usuarios.editar` porque esa
        -- cuenta (Cajera, Empleada) no lo tiene y se queda trancada en la
        -- pantalla de cambio de contraseña. Ver fn_cambio_contrasena_propio.
        IF TG_TABLE_NAME = 'usuarios'
           AND pos.fn_cambio_contrasena_propio(
                   fn_usuario_actual(), to_jsonb(NEW), to_jsonb(OLD))
        THEN
            RETURN NEW;
        END IF;
        PERFORM fn_exigir_permiso(v_update);
    ELSE
        PERFORM fn_exigir_permiso(v_delete);
    END IF;

    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ------------------------------------------------------------- invariante
--
-- La excepcion se comprueba con la sesion de una cuenta que NO puede
-- editar cuentas (la Cajera o la Empleada), que es justo la sesion que
-- fallaba. Si la comprobacion falla, la migracion se deshace sola.
--
-- La cuenta que se usa es una de verdad, pero sus cambios se deshacen: el
-- bloque de abajo es una subtransaccion que se revierte SIEMPRE, incluso
-- cuando todo sale bien. Por eso el "todo bien" se anuncia con una
-- excepcion propia que el bloque de afuera reconoce y se traga.
DO $$
DECLARE
    v_candidato BIGINT;
BEGIN
    -- Una cuenta activa que de verdad no pueda editar cuentas. Se descartan
    -- la dueña y el rol Administrador porque a ellos fn_es_admin() les
    -- pasa todo y no probarian nada.
    SELECT u.id INTO v_candidato
      FROM pos.usuarios u
     WHERE u.activo
       AND NOT u.es_dueno
       AND NOT EXISTS (
             SELECT 1
               FROM pos.usuarios_roles ur
               JOIN pos.roles r ON r.id = ur.rol_id
              WHERE ur.usuario_id = u.id
                AND r.nombre = 'Administrador')
       AND NOT EXISTS (
             SELECT 1
               FROM pos.usuarios_roles ur
               JOIN pos.roles_permisos rp ON rp.rol_id = ur.rol_id
               JOIN pos.permisos p        ON p.id = rp.permiso_id
              WHERE ur.usuario_id = u.id
                AND p.codigo = 'usuarios.editar')
     ORDER BY u.id
     LIMIT 1;

    IF v_candidato IS NULL THEN
        RAISE NOTICE
            'No hay ninguna cuenta sin usuarios.editar: la comprobacion se salta.';
        RETURN;
    END IF;

    BEGIN
        -- 1) Cambiar la PROPIA contraseña se acepta sin usuarios.editar.
        BEGIN
            PERFORM set_config('app.usuario_id', v_candidato::TEXT, TRUE);
            UPDATE pos.usuarios
               SET contrasena = crypt('ClaveDePrueba2026', gen_salt('bf', 12)),
                   debe_cambiar_contrasena = false,
                   intentos_fallidos = 0,
                   bloqueado_hasta = NULL
             WHERE id = v_candidato;

            IF NOT FOUND THEN
                RAISE EXCEPTION 'No se actualizó ninguna fila de la cuenta %', v_candidato;
            END IF;
        EXCEPTION WHEN insufficient_privilege THEN
            RAISE EXCEPTION
                'El cambio de la propia contraseña sigue exigiendo usuarios.editar';
        END;

        -- 2) Pero tocar cualquier otra cosa de la cuenta sigue exigiendo
        --    el permiso. Aqui se desactiva la propia cuenta: es el cambio
        --    mas pequeno que no es de contraseña.
        BEGIN
            UPDATE pos.usuarios
               SET activo = NOT activo
             WHERE id = v_candidato;

            RAISE EXCEPTION
                'Se permitió cambiar el activo de una cuenta sin usuarios.editar';
        EXCEPTION WHEN insufficient_privilege THEN
            NULL;   -- correcto: la base lo rechazó
        END;

        -- Se llega aqui solo si las dos comprobaciones salieron bien. La
        -- excepcion de abajo revierte el bloque entero, con la contraseña
        -- de prueba dentro, y la de arriba se la come.
        RAISE EXCEPTION 'comprobacion ok';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM = 'comprobacion ok' THEN
            RETURN;   -- todo bien, y el bloque ya se revirtió
        END IF;
        RAISE EXCEPTION 'La comprobacion de la migración falló: %', SQLERRM;
    END;
END
$$;
