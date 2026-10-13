-- 0018: permitir borrar notas canceladas con sus datos relacionados
--
-- Al eliminar una nota cancelada queremos liberar su folio y quitar también
-- lo que depende de ella (aplicaciones de pago, relación con facturas).
-- Las líneas de detalle ya tienen ON DELETE CASCADE.
ALTER TABLE pos.pagos_aplicacion
  DROP CONSTRAINT IF EXISTS pagos_aplicacion_nota_id_fkey,
  ADD CONSTRAINT pagos_aplicacion_nota_id_fkey
    FOREIGN KEY (nota_id) REFERENCES pos.notas_remision(id)
    ON DELETE CASCADE;

ALTER TABLE pos.factura_nota
  DROP CONSTRAINT IF EXISTS factura_nota_nota_id_fkey,
  ADD CONSTRAINT factura_nota_nota_id_fkey
    FOREIGN KEY (nota_id) REFERENCES pos.notas_remision(id)
    ON DELETE CASCADE;
