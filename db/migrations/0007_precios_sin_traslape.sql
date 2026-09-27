-- 0007: los precios no se traslapan en el tiempo.
--
-- Al exponer /api/precios aparecio un hueco que las tablas dejaron abierto
-- desde 0001, y este si es peligroso: no es un dato feo, es un dato que da
-- dos respuestas distintas a la misma pregunta.
--
-- Que dice 0001 sobre precios_cliente:
--
--   UNIQUE (cliente_id, producto_id, vigente_desde)
--   CONSTRAINT chk_vigencia_precios_cliente CHECK (
--       vigente_hasta IS NULL OR vigente_hasta >= vigente_desde)
--   CREATE UNIQUE INDEX uq_precios_cliente_vigente
--       ON precios_cliente(cliente_id, producto_id) WHERE vigente_hasta IS NULL;
--
-- Los tres juntos garantizan menos de lo que parecen:
--
-- - El UNIQUE de (cliente_id, producto_id, vigente_desde) prohibe dos
--   precios que empiecen el MISMO dia. No prohibe dos que se encimen.
-- - El indice parcial prohibe dos precios ABIERTOS a la vez. No prohibe que
--   uno cerrado termine DESPUES de que empiece el otro.
-- - El CHECK solo mira que el rango no este al reves.
--
-- O sea que las tres siguientes son legales hoy:
--
--   producto 1: 2026-01-01 a 2026-12-31   precio 90
--   producto 1: 2026-06-01 a NULL         precio 95   <- traslape
--   producto 1: 2026-06-01 a 2026-12-31   precio 95   <- traslape
--
-- Y el caso de la segunda es el que duele: el indice parcial NO lo salta,
-- porque su vigente_hasta es NULL y la primera fila esta cerrada. Y las dos
-- coexisten igual. El 15 de julio de 2026 ese producto tiene DOS precios
-- vigentes y "cual se cobra" deja de tener respuesta.
--
-- Para un precio de lista eso es un descuido. Para un precio pactado con
-- un cliente es un problema de contabilidad: la nota de remision guarda el
-- precio que se leyo en el momento, asi que dos notas del mismo dia pueden
-- llevar precios distintos por el mismo producto, y despues nadie podria
-- explicar la diferencia.
--
-- ESTE TRIGGER ES LA UNICA DEFENSA. No hay forma de expresar "estas dos
-- ventanas se pisan" con un indice unico, porque un indice unico solo
-- compara la clave y no los rangos: haria falta una restriccion de tabla,
-- que Postgres no tiene. Asi que va en el trigger.
--
-- Que se rechace con EXCEPTION y no con un NOTICE: un NOTICE deja la fila
-- escrita y la peticion contesta 200, y el frontend cree que guardo un
-- precio que en realidad no guardo. Prefiero el error.
--
-- Se dispara en UPDATE tambien, no solo en INSERT. Si no, la operacion de
-- "cambiale la fecha a este precio" esquivaria el control por la puerta de
-- atras, y un trigger que solo mira altas es peor que ninguno: da la
-- sensacion de que el dato esta protegido.
--
-- COALESCE(vigente_hasta, 'infinity'::date) convierte el NULL (abierto
-- hasta siempre) en una fecha maxima, con la que el traslape es una simple
-- comparacion de intervalos y no hace falta un caso especial para el
-- abierto. 'infinity' y no '9999-12-31' porque si alguien guardara esa
-- fecha de verdad, 'infinity' seguiria siendo mayor y el rango compararia
-- bien.

-- ---------------------------------------------------------------------
-- Publicos
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION fn_trg_precios_publicos_sin_traslape() RETURNS TRIGGER AS $$
DECLARE
    choques integer;
BEGIN
    SELECT count(*) INTO choques
    FROM precios_publicos p
    WHERE p.producto_id = NEW.producto_id
      -- la fila que se esta actualizando no cuenta como choque consigo misma
      AND (TG_OP = 'INSERT' OR p.id IS DISTINCT FROM NEW.id)
      -- traslape: las ventanas se pisan si el inicio de una es anterior o
      -- igual al fin de la otra, en los dos sentidos
      AND p.vigente_desde <= COALESCE(NEW.vigente_hasta, 'infinity'::date)
      AND NEW.vigente_desde <= COALESCE(p.vigente_hasta, 'infinity'::date);

    IF choques > 0 THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = format(
                'Ese precio se traslapa con otro ya vigente del producto (vigente de %s a %s)',
                NEW.vigente_desde,
                COALESCE(NEW.vigente_hasta::text, 'sin fecha de fin')
            ),
            DETAIL  = 'Un producto no puede tener dos precios vigentes en la misma fecha. Cierra el anterior o ajusta las fechas.',
            HINT    = 'Para cambiar un precio, cerralo con la fecha de fin de la vigencia anterior y da de alta el nuevo.';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_precios_publicos_sin_traslape
    BEFORE INSERT OR UPDATE ON precios_publicos
    FOR EACH ROW EXECUTE FUNCTION fn_trg_precios_publicos_sin_traslape();

-- ---------------------------------------------------------------------
-- De cliente
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION fn_trg_precios_cliente_sin_traslape() RETURNS TRIGGER AS $$
DECLARE
    choques integer;
BEGIN
    SELECT count(*) INTO choques
    FROM precios_cliente p
    WHERE p.cliente_id = NEW.cliente_id
      AND p.producto_id = NEW.producto_id
      AND (TG_OP = 'INSERT' OR p.id IS DISTINCT FROM NEW.id)
      AND p.vigente_desde <= COALESCE(NEW.vigente_hasta, 'infinity'::date)
      AND NEW.vigente_desde <= COALESCE(p.vigente_hasta, 'infinity'::date);

    IF choques > 0 THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = format(
                'Ese precio se traslapa con otro ya vigente de este cliente y producto (vigente de %s a %s)',
                NEW.vigente_desde,
                COALESCE(NEW.vigente_hasta::text, 'sin fecha de fin')
            ),
            DETAIL  = 'Un cliente no puede tener dos precios vigentes del mismo producto en la misma fecha.',
            HINT    = 'Para cambiar un precio, cerralo con la fecha de fin de la vigencia anterior y da de alta el nuevo.';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_precios_cliente_sin_traslape
    BEFORE INSERT OR UPDATE ON precios_cliente
    FOR EACH ROW EXECUTE FUNCTION fn_trg_precios_cliente_sin_traslape();

-- ---------------------------------------------------------------------
-- Lo que el trigger deja pasar y lo que no, en un solo lugar
-- ---------------------------------------------------------------------
--
-- Estos casos se comprueban contra la base en las pruebas de integracion
-- del modulo de precios. Se anotan aqui para que el dia que alguien los lea
-- sepa que son intencionales y no una falta de cobertura:
--
--   producto 1, 2026-01-01 a 2026-12-31   90    -- pasa
--   producto 1, 2026-06-01 a NULL         95    -- RECHAZADO (traslapa)
--   producto 1, 2026-06-01 a 2026-12-31   95    -- RECHAZADO (traslapa)
--   producto 1, 2026-12-31 a 2027-06-01   95    -- RECHAZADO: se pisan
--                                                   -- el 31 de diciembre
--   producto 1, 2027-01-01 a NULL         95    -- pasa: encadenado al
--                                                   -- dia siguiente
--   producto 2, 2026-01-01 a NULL         90    -- pasa (otro producto)
--
-- EL FIN ES INCLUSIVO, y eso fija la regla de encadenamiento: como un
-- precio que acaba el dia 31 SIGUE valiendo el dia 31, el que empieza el
-- dia 1 de enero tiene que ser el siguiente, no el mismo 31. Encadenar
-- "el mismo dia" se rechaza, y con razon: ese dia tendria dos precios.
--
-- Esto no es un capricho del trigger, es lo que ya dice el filtro de
-- vigencia de la API, que compara con `vigente_hasta >= $fecha`: si el fin
-- fuera exclusivo, el filtro y el trigger estarian contando distinto y un
-- precio se veria en el listado un dia antes de que el trigger lo dejara
-- pasar. Si el negocio quiere el fin exclusivo, hay que cambiar el trigger,
-- el CHECK de 0001 y el filtro del modulo, juntos y en el mismo cambio.
--
-- La fecha de hoy no se pone como valor por omision en el trigger. Si se
-- pusiera, un INSERT sin fechas que coincide con otra ventana pasaria
-- ("lo omite el trigger, lo pone Postgres"), y entonces el trigger solo
-- protegeria a quien escribiera las fechas a mano. El INSERT del modulo
-- escribe CURRENT_DATE explicitamente, y el trigger compara contra eso.

-- ---------------------------------------------------------------------
-- Nota sobre el borrado fisico
-- ---------------------------------------------------------------------
--
-- No se agrego ninguna regla en contra del DELETE en estas dos tablas, y no
-- es un olvido. El comentario de 0001 ya lo resolvio:
--
--   "Precio especial pactado por cliente y producto (historico: nunca se
--    borra un precio viejo, se cierra su vigencia y se abre uno nuevo)"
--
-- Un precio borrado es un hueco en la historia de facturacion: las notas de
-- remision guardan el precio que se leyo al cobrar, y si despues se borra
-- la fila ya no hay forma de reconstruir de donde salio ese numero. Por
-- eso el modulo de precios NO expone DELETE: expone "cerrar", que es un
-- UPDATE de vigente_hasta.
