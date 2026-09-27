-- 0009: la compra se puede cancelar con motivo.
--
-- CONTEXTO. Al exponer compras aparecio un hueco que en notas de remision
-- ya estaba cerrado desde 0008, y el patron es el mismo:
--
-- `compras` tiene `estatus` con 'cancelada' desde 0001, y
-- `fn_revertir_inventario_por_cancelacion_compra` ya devuelve los bultos a
-- la bodega cuando se cancela. Lo que NO existia era el motivo. O sea: se
-- podia cancelar una compra y sacar mercancia del inventario sin que
-- quedara escrito por que.
--
-- Notas de remision tiene `motivo_cancelacion` con un CHECK que lo hace
-- obligatorio (`chk_notas_motivo_cancelacion`, 0008). Este es el mismo
-- motivo para compras, y va en la base y no en el servicio a proposito: si
-- la regla solo vive en TypeScript, un UPDATE escrito a mano en psql
-- cancela la compra sin motivo y nadie se entera.
--
-- El CHECK se escribe con `NOT VALID` + `VALIDATE CONSTRAINT` para poder
-- ponerlo sobre una tabla que ya tiene filas: anadirlo y validarlo en el
-- mismo comando falla si hay alguna compra cancelada sin motivo, y no se
-- puede exigir a una instalacion existente que sus compras canceladas
-- tengan un texto que nunca se pidio.
--
-- CONVENCION (ver backend/scripts/migrar.ts): sin BEGIN/COMMIT y sin
-- INSERT en schema_migrations. Eso es del runner.

ALTER TABLE pos.compras
  ADD COLUMN IF NOT EXISTS motivo_cancelacion TEXT;

ALTER TABLE pos.compras
  DROP CONSTRAINT IF EXISTS chk_compras_motivo_cancelacion;

ALTER TABLE pos.compras
  ADD CONSTRAINT chk_compras_motivo_cancelacion CHECK (
    estatus <> 'cancelada' OR (motivo_cancelacion IS NOT NULL AND btrim(motivo_cancelacion) <> '')
  ) NOT VALID;

-- Las compras que YA estaban canceladas cuando se aplico esta migracion no
-- tienen motivo, y el CHECK las dejaria fuera. Se rellena con un texto
-- explicito antes de validar, para que la fila diga la verdad ("no se
-- registro") en vez de mentir con un motivo inventado.
UPDATE pos.compras
   SET motivo_cancelacion = 'Cancelada antes de que existiera el motivo de cancelacion'
 WHERE estatus = 'cancelada'
   AND (motivo_cancelacion IS NULL OR btrim(motivo_cancelacion) = '');

ALTER TABLE pos.compras
  VALIDATE CONSTRAINT chk_compras_motivo_cancelacion;

COMMENT ON COLUMN pos.compras.motivo_cancelacion IS
  'Por que se cancelo la compra. Obligatorio si estatus = cancelada, lo exige chk_compras_motivo_cancelacion.';
