import { describe, expect, it } from 'vitest';
import { componerFolio } from '../../src/modules/notas-remision/modelo.js';
import {
  crearNotaEsquema,
  crearTalonarioEsquema,
  establecerSerieActivaEsquema,
} from '../../src/modules/notas-remision/esquemas.js';

/**
 * El formato del folio y el esquema del talonario.
 *
 * La regla de la serie (el prefijo) vive ENTERA aqui: puede ir vacia, se
 * normaliza a mayusculas sin espacios, y de ahi sale el texto que se quema
 * en cada nota. Es logica pura y corre sin base ni servidor.
 */

describe('componerFolio', () => {
  it('con serie vacia es solo el numero: el formato del negocio', () => {
    expect(componerFolio('', 2704)).toBe('2704');
  });

  it('con serie imprime el prefijo y el numero', () => {
    expect(componerFolio('RE', 2704)).toBe('RE-2704');
  });

  it('el guion es parte del prefijo impreso, no del formato', () => {
    // La serie no lleva guion: si alguien quiere "RE-", lo escribe en el
    // prefijo. Vaciar la serie borra el guion tambien, y "2704" es un
    // folio diferente de "A-2704".
    expect(componerFolio('RE-', 2704)).toBe('RE--2704');
  });
});

describe('crearTalonarioEsquema', () => {
  it('la serie vacia es el default: puros numeros', () => {
    const r = crearTalonarioEsquema.parse({ desde: 2704, hasta: 2706 });
    expect(r.serie).toBe('');
  });

  it('normaliza el prefijo: mayusculas y sin espacios', () => {
    const r = crearTalonarioEsquema.parse({ serie: '  re ', desde: 1, hasta: 1 });
    expect(r.serie).toBe('RE');
  });

  it('rechaza un prefijo de mas de 10 caracteres', () => {
    expect(() =>
      crearTalonarioEsquema.parse({ serie: 'ABCDEFGHIJK', desde: 1, hasta: 1 }),
    ).toThrow();
  });

  it('desde y hasta son enteros positivos y en orden', () => {
    expect(() => crearTalonarioEsquema.parse({ desde: 0, hasta: 1 })).toThrow();
    expect(() => crearTalonarioEsquema.parse({ desde: 5, hasta: 4 })).toThrow(
      /hasta no puede ser menor/,
    );
  });

  it('corta el tramo en 5000 folios por llamada', () => {
    expect(() => crearTalonarioEsquema.parse({ desde: 1, hasta: 5001 })).toThrow(/5000/);
    expect(() => crearTalonarioEsquema.parse({ desde: 1, hasta: 5000 })).not.toThrow();
  });

  it('rechaza las llaves que no conoce (el esquema es strict)', () => {
    expect(() => crearTalonarioEsquema.parse({ desde: 1, hasta: 2, subtotal: 10 })).toThrow();
  });
});

describe('establecerSerieActivaEsquema', () => {
  it('el default es la serie vacia: puros numeros', () => {
    const r = establecerSerieActivaEsquema.parse({});
    expect(r.serie).toBe('');
  });

  it('normaliza el prefijo', () => {
    const r = establecerSerieActivaEsquema.parse({ serie: 'B ' });
    expect(r.serie).toBe('B');
  });
});

describe('crearNotaEsquema: la serie activa es cosa del backend', () => {
  it('la serie es OPCIONAL en el alta de la nota', () => {
    // El POS no manda serie: la resuelve el servicio leyendo
    // `serie_folio_activa`. Si llegara, se tomaria como el fromato elegido
    // para esa nota.
    const base = {
      cliente_id: 3,
      renglones: [{ producto_id: 7, almacen_id: 1, cantidad_bultos: '1', kg_bulto: '20' }],
    };
    expect(crearNotaEsquema.parse(base)).not.toHaveProperty('serie');
  });
});
