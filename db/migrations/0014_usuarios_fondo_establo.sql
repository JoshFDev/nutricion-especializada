-- El establo entra a la lista de fondos del login.
--
-- Es el mismo camino que la 0013, pero para AGREGAR una clave: el CHECK de
-- `usuarios_fondo_login_check` es una lista escrita a mano y no se puede ampliar
-- con la 0013, que ya esta aplicada. Por eso se suelta el CHECK y se vuelve a
-- poner con la lista nueva.
--
-- Se suelta y se vuelve a poner, y no se anade otro CHECK al lado, porque dos
-- CHECK sobre la misma columna se evaluan los dos: el viejo seguiria rechazando
-- 'establo' y el nuevo no serviria de nada.
--
-- `NULL` sigue significando "el de por defecto", y el de por defecto ahora es
-- `establo` (ver `usuarios/fondos-login.ts`). Los usuarios que nunca eligieron
-- fondo no tienen nada que migrar: su columna es NULL y se resuelve sola. Los
-- que habian elegido `vacaLengua` o `vacaFondo` los conservan, porque elegir un
-- fondo es una decision y no se pisa sola.

ALTER TABLE pos.usuarios
    DROP CONSTRAINT IF EXISTS usuarios_fondo_login_check;

ALTER TABLE pos.usuarios
    ADD CONSTRAINT usuarios_fondo_login_check
    CHECK (fondo_login IS NULL OR fondo_login IN ('vacaLengua', 'vacaFondo', 'establo'));
