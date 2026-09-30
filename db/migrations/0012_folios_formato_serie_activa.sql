-- ---------------------------------------------------------------------
-- El FORMATO del folio lo elige la persona que administra el talonario
-- ---------------------------------------------------------------------
--
-- La serie es el prefijo visible del folio. Hasta 0011 solo podia ser un
-- texto de 1 a 10 caracteres ("A", "RE"...), lo que hacia imposible el
-- folio de puros numeros: el caso normal del negocio, que tiene la serie
-- impresa en el papel y solo necesita la numeracion. A partir de aqui la
-- serie puede ir VACIA, y entonces el folio es solo el numero ("2704").
--
-- La unica regla que queda es que no tenga espacios de los lados y que no
-- pase de 10 caracteres, porque el prefijo es lo que se imprime en cada
-- nota. Lo demas (cuando permite el alta, como se muestra y se busca) lo
-- decide el codigo de la api, cuyos esquemas normalizan a mayusculas.

ALTER TABLE folios
    DROP CONSTRAINT folios_serie_check;

ALTER TABLE folios
    ADD CONSTRAINT folios_serie_check
    CHECK (serie = btrim(serie) AND char_length(serie) <= 10);

-- La serie que el POS usa para el siguiente folio.
--
-- Una sola fila (id = 1 fijo): es una preferencia, no un catalogo. La
-- guarda `PUT /folios/serie-activa` con el permiso `notas.folios`, y el
-- alta de una nota la lee para saber de que talonario quemar. Arranca
-- vacia (puros numeros), que es el formato del negocio; los folios se
-- cargan aparte con `fn_allegar_folios` desde la pantalla del POS.
CREATE TABLE serie_folio_activa (
    id             INTEGER PRIMARY KEY CHECK (id = 1),
    serie          TEXT NOT NULL CHECK (serie = btrim(serie) AND char_length(serie) <= 10),
    actualizada_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO serie_folio_activa (id, serie) VALUES (1, '');