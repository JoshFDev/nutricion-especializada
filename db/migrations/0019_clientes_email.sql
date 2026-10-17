-- 0019: correo electrónico del cliente
--
-- Se usa para avisarle al cliente, por correo, la nota de remisión que se le
-- levantó (mini ticket) y su cancelación. Es opcional: no todos los clientes
-- lo tienen, y uno sin correo simplemente no recibe la notificación.
--
-- Va como columna propia y no en `datos_fiscales_cliente` porque ese dato es
-- de facturación (RFC/razón social), no de contacto. El correo es del cliente
-- y se captura en la pantalla de clientes.

ALTER TABLE pos.clientes
  ADD COLUMN IF NOT EXISTS email TEXT;

COMMENT ON COLUMN pos.clientes.email IS
  'Correo de contacto para las notificaciones de notas de remisión. Nulo = sin notificación.';

-- El correo se usa para buscarlo y para impedir duplicados entre clientes
-- (dos clientes con el mismo correo es casi siempre un alta repetida). El
-- índice es por `lower(email)` para que no importe mayúsculas y se ignora el
-- nulo, que es el caso normal de un cliente sin correo.
CREATE UNIQUE INDEX IF NOT EXISTS idx_clientes_email_unico
  ON pos.clientes (lower(email))
  WHERE email IS NOT NULL;
