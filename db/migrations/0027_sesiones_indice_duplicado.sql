-- 0027: el indice de sesiones que ya existia con otro nombre.
--
-- CONTEXTO. `sesiones.token_hash` es UNIQUE, y ese constraint ya crea un
-- indice. Ademas, 0001 creo `idx_sesiones_token` sobre la MISMA columna.
-- Son dos indices identicos: la busqueda por token usa uno, el otro solo se
-- paga en cada login (INSERT), en cada logout (UPDATE) y en cada limpieza.
--
-- No se reemplaza por nada: el indice del UNIQUE se queda y hace el mismo
-- trabajo. Un indice de mas no es gratis.

DROP INDEX IF EXISTS pos.idx_sesiones_token;
