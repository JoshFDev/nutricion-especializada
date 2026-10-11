import { describe, expect, it } from 'vitest';
import {
  reporteConsumoEsquema,
  reporteEstadoCuentaEsquema,
  reporteExistenciaEsquema,
} from '../../src/modules/reportes/esquemas.js';

/**
 * Pruebas de los esquemas de reportes.
 *
 * Son logica pura, asi que corren en milisegundos sin base ni servidor. Lo que
 * mas importa aqui es la BANDERA: `z.coerce.boolean()` convertiria cualquier
 * cadena no vacia en `true`, de modo que `?solo_con_existencia=false` se leeria
 * al reves. El `enum` es lo que evita eso, y por eso se prueba.
 */

describe('la bandera de un reporte', () => {
  it('"true" enciende y "false" apaga', () => {
    expect(
      reporteExistenciaEsquema.parse({ solo_con_existencia: 'true' }).solo_con_existencia,
    ).toBe(true);
    expect(
      reporteExistenciaEsquema.parse({ solo_con_existencia: 'false' }).solo_con_existencia,
    ).toBe(false);
  });

  it('sin bandera queda apagada', () => {
    expect(reporteExistenciaEsquema.parse({}).solo_con_existencia).toBe(false);
  });

  it('lo que no sea "true" ni "false" es un 400', () => {
    for (const mala of ['1', '0', 'si', '']) {
      expect(() => reporteExistenciaEsquema.parse({ solo_con_existencia: mala })).toThrow();
    }
  });

  it('la del estado de cuenta es independiente', () => {
    const r = reporteEstadoCuentaEsquema.parse({ solo_con_saldo: 'true' });
    expect(r.solo_con_saldo).toBe(true);
  });
});

describe('la paginacion de un reporte', () => {
  it('sin nada, pide los primeros cincuenta desde el inicio', () => {
    expect(reporteExistenciaEsquema.parse({})).toMatchObject({ limite: 50, offset: 0 });
  });

  it('respeta el limite y el offset que lleguen como texto', () => {
    expect(reporteExistenciaEsquema.parse({ limite: '25', offset: '50' })).toMatchObject({
      limite: 25,
      offset: 50,
    });
  });

  it('rechaza un limite fuera del rango del compartido', () => {
    expect(() => reporteExistenciaEsquema.parse({ limite: '0' })).toThrow();
    expect(() => reporteExistenciaEsquema.parse({ limite: '500' })).toThrow();
  });
});

describe('la busqueda', () => {
  it('es opcional', () => {
    expect(reporteExistenciaEsquema.parse({}).buscar).toBeUndefined();
  });

  it('acepta texto normal y rechaza el que pasa del tope', () => {
    expect(reporteExistenciaEsquema.parse({ buscar: 'LAC' }).buscar).toBe('LAC');
    expect(() => reporteExistenciaEsquema.parse({ buscar: 'x'.repeat(121) })).toThrow();
  });
});

describe('lo que NO entra', () => {
  it('un parametro de mas es un 400, no un filtro ignorado', () => {
    expect(() => reporteExistenciaEsquema.parse({ solo_con_saldo: 'true' })).toThrow();
    expect(() => reporteEstadoCuentaEsquema.parse({ solo_con_existencia: 'true' })).toThrow();
  });

  it('un id no positivo se rechaza', () => {
    expect(() => reporteConsumoEsquema.parse({ cliente_id: '0' })).toThrow();
    expect(() => reporteExistenciaEsquema.parse({ almacen_id: '40000' })).toThrow();
  });
});

describe('el consumo', () => {
  it('el cliente y el producto son opcionales', () => {
    expect(reporteConsumoEsquema.parse({})).not.toHaveProperty('cliente_id');
    expect(reporteConsumoEsquema.parse({ cliente_id: '7', producto_id: '3' })).toMatchObject({
      cliente_id: 7,
      producto_id: 3,
    });
  });
});
