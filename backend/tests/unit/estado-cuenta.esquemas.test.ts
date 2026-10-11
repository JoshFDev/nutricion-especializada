import { describe, expect, it } from 'vitest';
import {
  hojaEstadoCuentaEsquema,
  listarEstadoCuentaEsquema,
} from '../../src/modules/estado-cuenta/esquemas.js';

/**
 * Los esquemas del estado de cuenta.
 *
 * Es logica pura, asi que corre sin base ni servidor. Lo que mas importa es la
 * BANDERA: `z.coerce.boolean()` volveria `true` a cualquier cadena no vacia,
 * de modo que `?solo_con_saldo=false` se leeria al reves. El `enum` es lo que
 * evita eso, y por eso se prueba.
 */

describe('la bandera de "solo con saldo"', () => {
  it('"true" enciende y "false" apaga', () => {
    expect(listarEstadoCuentaEsquema.parse({ solo_con_saldo: 'true' }).solo_con_saldo).toBe(true);
    expect(listarEstadoCuentaEsquema.parse({ solo_con_saldo: 'false' }).solo_con_saldo).toBe(false);
  });

  it('sin bandera queda apagada', () => {
    expect(listarEstadoCuentaEsquema.parse({}).solo_con_saldo).toBe(false);
  });

  it('lo que no sea "true" ni "false" es un 400', () => {
    for (const mala of ['1', '0', 'si', '']) {
      expect(() => listarEstadoCuentaEsquema.parse({ solo_con_saldo: mala })).toThrow();
    }
  });
});

describe('la paginacion del listado', () => {
  it('sin nada, pide los primeros cincuenta desde el inicio', () => {
    expect(listarEstadoCuentaEsquema.parse({})).toMatchObject({ limite: 50, offset: 0 });
  });

  it('respeta el limite y el offset que lleguen como texto', () => {
    expect(listarEstadoCuentaEsquema.parse({ limite: '25', offset: '50' })).toMatchObject({
      limite: 25,
      offset: 50,
    });
  });

  it('rechaza un limite fuera del rango del compartido', () => {
    expect(() => listarEstadoCuentaEsquema.parse({ limite: '0' })).toThrow();
    expect(() => listarEstadoCuentaEsquema.parse({ limite: '500' })).toThrow();
  });
});

describe('la busqueda', () => {
  it('es opcional', () => {
    expect(listarEstadoCuentaEsquema.parse({}).buscar).toBeUndefined();
  });

  it('acepta texto normal y rechaza el que pasa del tope', () => {
    expect(listarEstadoCuentaEsquema.parse({ buscar: 'LAC' }).buscar).toBe('LAC');
    expect(() => listarEstadoCuentaEsquema.parse({ buscar: 'x'.repeat(121) })).toThrow();
  });
});

describe('lo que NO entra', () => {
  it('un parametro de mas es un 400, no un filtro ignorado', () => {
    expect(() => listarEstadoCuentaEsquema.parse({ solo_con_existencia: 'true' })).toThrow();
  });

  it('la hoja solo valida el id del cliente', () => {
    expect(hojaEstadoCuentaEsquema.parse({ id: '7' })).toEqual({ id: 7 });
    expect(() => hojaEstadoCuentaEsquema.parse({ id: '0' })).toThrow();
    expect(() => hojaEstadoCuentaEsquema.parse({ id: '7', extra: 'x' })).toThrow();
  });
});
