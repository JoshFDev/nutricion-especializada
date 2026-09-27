-- 0010: las facturas se auditan y respetan permisos.
--
-- CONTEXTO. Al exponer facturacion aparecio un hueco que las demas tablas del
-- negocio no tienen, y es el unico donde 0001 se dejo algo a medias:
--
--   - `facturas` y `factura_nota` NO tienen trigger de auditoria. Ninguna otra
--     tabla de dinero la tiene ausente: `pagos`, `compras`, `notas_remision`,
--     `movimientos_financieros` y `inventario_movimientos` se llenan solas en
--     `auditoria_log`. Una factura es un documento fiscal; que se pueda
--     cambiar de estatus o borrar sin dejar rastro es exactamente el escenario
--     para el que existe la bitacora.
--
--   - Tampoco tienen trigger de permiso. `fn_trg_permiso` esta en clientes,
--     notas, pagos, precios, compras, inventario, usuarios y movimientos de
--     caja, y los permisos `facturas.solicitar` / `facturas.emitir` existen
--     desde 0001 sin que nada los ejija. O sea: hay un permiso concedido que
--     no abre ninguna puerta, que es peor que no concederlo, porque parece
--     que funciona y no funciona.
--
-- TAMBIEN: `motivo_cancelacion`, igual que en notas (0008) y compras (0009).
-- El patron ya esta establecido dos veces y aqui faltaba: `facturas.estatus`
-- tiene 'cancelada' desde 0001, y se podia cancelar una factura sin que nadie
-- supiera por que. La regla va en la base y no en el servicio a proposito: si
-- vive solo en TypeScript, un UPDATE escrito a mano en psql cancela la
-- factura sin motivo y no se entera nadie.
--
-- EL CHECK va `NOT VALID` + `VALIDATE CONSTRAINT` por lo mismo que en 0009:
-- anadirlo y validarlo en el mismo comando falla si hay alguna factura ya
-- cancelada sin motivo, y no se le puede exigir a una instalacion existente un
-- texto que nunca se pidio.
--
-- POR QUE INSERT y UPDATE piden `facturas.solicitar` y no `facturas.emitir`:
-- el trigger solo puede exigir un permiso por operacion, y el INSERT es
-- justamente "solicitar". La parte que si necesita `facturas.emitir` -- pasar
-- de solicitada a emitida, y cancelar una emitida -- la valida el servicio,
-- que si sabe de que estatus a que estatus se va. El trigger queda como el
-- piso: sin sesion no se autoriza nada (migraciones, seed y psql siguen
-- funcionando) y con sesion hace falta el permiso de base.
--
-- CONVENCION (ver backend/scripts/migrar.ts): sin BEGIN/COMMIT y sin
-- INSERT en schema_migrations. Eso es del runner.

-- --------------------------------------------------------------- motivo
ALTER TABLE pos.facturas
  ADD COLUMN IF NOT EXISTS motivo_cancelacion TEXT;

ALTER TABLE pos.facturas
  DROP CONSTRAINT IF EXISTS chk_facturas_motivo_cancelacion;

ALTER TABLE pos.facturas
  ADD CONSTRAINT chk_facturas_motivo_cancelacion CHECK (
    estatus <> 'cancelada' OR (motivo_cancelacion IS NOT NULL AND btrim(motivo_cancelacion) <> '')
  ) NOT VALID;

-- Las facturas YA canceladas cuando se aplico esta migracion no tienen
-- motivo. Se rellena con un texto explicito antes de validar, para que la
-- fila diga la verdad ("no se registro") en vez de mentir con un motivo
-- inventado.
UPDATE pos.facturas
   SET motivo_cancelacion = 'Cancelada antes de que existiera el motivo de cancelacion'
 WHERE estatus = 'cancelada'
   AND (motivo_cancelacion IS NULL OR btrim(motivo_cancelacion) = '');

ALTER TABLE pos.facturas
  VALIDATE CONSTRAINT chk_facturas_motivo_cancelacion;

COMMENT ON COLUMN pos.facturas.motivo_cancelacion IS
  'Por que se cancelo la factura. Obligatorio si estatus = cancelada, lo exige chk_facturas_motivo_cancelacion.';

-- ------------------------------------------------------------- auditoria
CREATE TRIGGER trg_facturas_auditoria
    AFTER INSERT OR UPDATE OR DELETE ON pos.facturas
    FOR EACH ROW EXECUTE FUNCTION pos.fn_auditoria();

-- `factura_nota` tambien se audita, y no es sobra: es la tabla que dice que
-- notas cubre cada factura, o sea DONDE ESTA EL DINERO de la factura. Una
-- factura sin cambios en su bitacora pero con sus notas cambiadas es una
-- factura que ya no dice lo que dice.
CREATE TRIGGER trg_factura_nota_auditoria
    AFTER INSERT OR UPDATE OR DELETE ON pos.factura_nota
    FOR EACH ROW EXECUTE FUNCTION pos.fn_auditoria();

-- ------------------------------------------------------------- permisos
CREATE TRIGGER trg_permiso_facturas
    BEFORE INSERT OR UPDATE OR DELETE ON pos.facturas
    FOR EACH ROW EXECUTE FUNCTION pos.fn_trg_permiso('facturas.solicitar','facturas.solicitar','facturas.emitir');

-- El vinculo entre la factura y la nota es parte del documento: mover una
-- nota de una factura a otra cambia a quien se le factura cuanto, asi que
-- exige el mismo permiso que mover la factura misma.
CREATE TRIGGER trg_permiso_factura_nota
    BEFORE INSERT OR UPDATE OR DELETE ON pos.factura_nota
    FOR EACH ROW EXECUTE FUNCTION pos.fn_trg_permiso('facturas.solicitar','facturas.solicitar','facturas.emitir');

-- `factura_nota` no tiene `id`: es una tabla de dos columnas y su clave es el
-- par. `fn_auditoria` saca el id de los JSONB con
-- `(v_nuevo ->> 'id')::BIGINT`, que aqui es NULL, asi que su fila de bitacora
-- queda con `registro_id` NULL y el par viaja dentro de
-- `datos_nuevos`/`datos_anteriores`. Para reconstruir el historial de una
-- factura hay que filtrar por `datos_nuevos->>'factura_id'`.
--
-- Se documenta porque es lo unico de esta migracion que es una concesion y no
-- una mejora, y la siguiente persona que lea `auditoria_log` va a esperar un
-- `registro_id` y no lo va a encontrar. El precio de arreglarlo de raiz es
-- agregar una columna `llave TEXT` con su indice a `auditoria_log`, para una
-- tabla que tiene dos columnas: no se paga eso todavia.

-- ------------------------------------------------------------- invariante
-- Este bloque no REVOCA permisos: es una red de seguridad para cuando alguien
-- escriba aqui a mano. Comprueba que la tabla de permisos y la de facturas
-- siguen de acuerdo en lo que esta migracion acaba de cablear.
--
-- Sin contador y con dos EXISTS: contar sobre un VALUES correlacionado obliga
-- a acertar el alias (`esperados` contra `esperado`), y acertarlo mal falla
-- al APLICAR la migracion, no al detectar el problema que la migracion
-- busca. Aqui el problema que se reporta es el de los permisos, y el motor
-- no se atraviesa en el camino.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pos.permisos WHERE codigo = 'facturas.solicitar') THEN
    RAISE EXCEPTION
      'Falta el permiso facturas.solicitar, que el trigger trg_permiso_facturas exige';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pos.permisos WHERE codigo = 'facturas.emitir') THEN
    RAISE EXCEPTION
      'Falta el permiso facturas.emitir, que el trigger trg_permiso_facturas exige en DELETE';
  END IF;
END
$$;
