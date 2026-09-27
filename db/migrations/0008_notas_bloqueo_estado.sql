-- 0008: la nota de remision se congela cuando ya no se puede tocar.
--
-- CONTEXTO. Al exponer notas de remision aparecieron dos huecos que la base
-- no cubria, y los dos son del mismo tipo: la baseava "en que estado esta
-- la nota" para el INVENTARIO y para el SALDO, pero no para "se puede
-- editar". Ningun trigger miraba `estatus` al escribir renglones.
--
-- 1) Renglones en una nota cancelada. `fn_sincronizar_inventario_venta`
--    (0001) hace esto:
--
--        IF NOT EXISTS (... estatus = 'cancelada') THEN
--            INSERT INTO inventario_movimientos ... 'salida_venta' ...
--
--    O sea: si la nota esta cancelada, NO crea el movimiento de salida, y
--    sigue adelante sin decir nada. El renglón se guarda, el subtotal de la
--    nota sube, el cliente debe mas... y el stock nunca se movio. Peor que
--    un error: es un error que no parece error. Y como
--    `fn_recalcular_subtotal_nota` recalcula el subtotal igual, la nota
--    queda debiendo producto que la bodega no ha entregado.
--
-- 2) Editar una nota ya pagada. `fn_actualizar_estatus_por_aplicaciones`
--    deja el estatus en 'pagada' y el saldo del cliente ya se descontó. Si
--    despues se edita el detalle, el subtotal se recalcula y el estatus
--    sigue diciendo 'pagada' aunque lo aplicado ya no cubra: el trigger de
--    estatus solo se dispara por `pagos_aplicacion`, no por un cambio de
--    monto. O sea que la nota queda pagada y debiendo mas de lo pagado, sin
--    que nada lo note.
--
-- Lo que hace esta migracion es poner la regla DONDE ya estan las demas:
-- en la base, no solo en el servicio. El servicio la va a repetir para dar
-- un 409 con mensaje util, pero un trigger y un `CASE` en TypeScript no se
-- van a desincronizar solos, y esta vez el que se desincronizo seria el que
-- protege dinero.
--
-- CONVENCION (ver backend/scripts/migrar.ts): sin BEGIN/COMMIT y sin
-- INSERT en schema_migrations. Eso es del runner.

-- ------------------------------------------------- motivo de cancelacion
--
-- Una cancelacion saca mercancia de la cuenta del cliente y devuelve
-- bultos a la bodega. Sin un "¿por que?", lo que queda es un boton que
-- borra trabajo. Lo exige el CHECK, no el servicio: asi tampoco se puede
-- cancelar escribiendo directo a SQL.
ALTER TABLE pos.notas_remision
  ADD COLUMN IF NOT EXISTS motivo_cancelacion TEXT;

ALTER TABLE pos.notas_remision
  DROP CONSTRAINT IF EXISTS chk_notas_motivo_cancelacion;

ALTER TABLE pos.notas_remision
  ADD CONSTRAINT chk_notas_motivo_cancelacion CHECK (
    estatus <> 'cancelada' OR (motivo_cancelacion IS NOT NULL AND btrim(motivo_cancelacion) <> '')
  );

COMMENT ON COLUMN pos.notas_remision.motivo_cancelacion IS
  'Por que se cancelo la nota. Obligatorio si estatus = cancelada, lo exige chk_notas_motivo_cancelacion.';

-- --------------------------------------------- congelar la nota pagada
--
-- Solo bloquea el CONTENIDO: cliente, fecha, direccion, vendedor y folio.
--
-- El estatus sigue libre a proposito, y no por descuido:
--   * `fn_actualizar_estatus_por_aplicaciones` hace un UPDATE de estatus
--     sobre la nota, y lo hace tambien cuando la nota YA esta pagada
--     (escribe el mismo valor: `WHEN n.estatus IN ('pagada','cancelada')
--     THEN n.estatus`). Si este trigger mirara "la nota esta pagada, no
--     la toques", cada aplicacion de un pago a una nota pagada reventaria
--     con 23514 y el modulo de pagos dejaria de funcionar.
--   * Cancelar una nota pagada tiene que poder pasar, porque es la unica
--     forma de deshacer un cobro.
--
-- Por eso la comparacion es "cambio algo que NO es el estatus". El
-- estatus lo gobierna el trigger de pagos y el servicio con sus reglas;
-- aqui solo se congela el documento.
CREATE OR REPLACE FUNCTION fn_congelar_nota_pagada()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.estatus IN ('pagada', 'cancelada')
       AND (NEW.cliente_id        IS DISTINCT FROM OLD.cliente_id
         OR NEW.fecha              IS DISTINCT FROM OLD.fecha
         OR NEW.direccion_entrega  IS DISTINCT FROM OLD.direccion_entrega
         OR NEW.vendedor_id        IS DISTINCT FROM OLD.vendedor_id
         OR NEW.folio_id           IS DISTINCT FROM OLD.folio_id) THEN
        RAISE EXCEPTION
            'La nota % esta % y no se puede modificar: cancelala si de verdad hay que deshacerla',
            OLD.id, OLD.estatus
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_congelar_nota_pagada
    BEFORE UPDATE ON pos.notas_remision
    FOR EACH ROW EXECUTE FUNCTION fn_congelar_nota_pagada();

-- --------------------------------------------------- congelar el detalle
--
-- Esta es la que cierra el hueco 1. Se dispara en INSERT, UPDATE y DELETE
-- del renglon, y en los tres casos mira el estatus de la nota madre: en
-- DELETE tambien, porque borrar renglones de una nota pagada es la forma
-- de rebajar la deuda sin que el estatus se entere.
--
-- El trigger de inventario (0001) corre en AFTER y en UPDATE/DELETE borra
-- el movimiento viejo antes de crear el nuevo. Si este lo detiene antes, el
-- movimiento no se toca. El orden importa y por eso es BEFORE.
CREATE OR REPLACE FUNCTION fn_congelar_renglones_nota()
RETURNS TRIGGER AS $$
DECLARE
    v_nota_id BIGINT := COALESCE(NEW.nota_id, OLD.nota_id);
    v_estatus TEXT;
BEGIN
    SELECT estatus INTO v_estatus
      FROM pos.notas_remision
     WHERE id = v_nota_id;

    IF v_estatus IN ('pagada', 'cancelada') THEN
        RAISE EXCEPTION
            'La nota % esta % y sus renglones no se pueden tocar',
            v_nota_id, v_estatus
            USING ERRCODE = '23514';
    END IF;

    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_congelar_renglones_nota
    BEFORE INSERT OR UPDATE OR DELETE ON pos.nota_remision_detalle
    FOR EACH ROW EXECUTE FUNCTION fn_congelar_renglones_nota();

-- ---------------------------------------------------------------- permiso
--
-- `notas.folios` es para el ADMINISTRADOR y solo el: el talonario decide
-- que numeros de documento existen, y un empleado que captura notas no
-- deberia poder extenderlo. Es un permiso nuevo y no `notas.crear` a
-- proposito: con `notas.crear` lo tendria tambien la Empleada, que es
-- justo a quien NO se le quiere dar esta tarea.
INSERT INTO pos.permisos (codigo, modulo, accion, descripcion, es_escritura) VALUES
  ('notas.folios', 'notas', 'folios', 'Administrar el talonario de folios de remision', true)
ON CONFLICT (codigo) DO NOTHING;

INSERT INTO pos.roles_permisos (rol_id, permiso_id)
SELECT r.id, p.id
  FROM roles r
  CROSS JOIN permisos p
 WHERE p.codigo = 'notas.folios'
   AND r.nombre = 'Administrador'
ON CONFLICT (rol_id, permiso_id) DO NOTHING;
