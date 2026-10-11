import { describe, expect, it } from 'vitest';
import { parametrosDe } from './reportes-api';

/**
 * Los parametros de los tres reportes.
 *
 * Se prueba la funcion pura y no la llamada: el esquema del backend es
 * `strict`, y un parametro de mas da un 400. Por eso lo que importa es QUE se
 * manda y que NO.
 */

describe('los parametros de un reporte', () => {
  it('por defecto pide los primeros veinticinco, desde el inicio', () => {
    expect(parametrosDe({})).toEqual({ limite: 25, offset: 0 });
  });

  it('respeta el limite y el offset que se le den', () => {
    expect(parametrosDe({ limite: 100, offset: 50 })).toEqual({ limite: 100, offset: 50 });
  });

  it('la busqueda solo viaja desde dos caracteres', () => {
    expect(parametrosDe({})).not.toHaveProperty('buscar');
    expect(parametrosDe({ buscar: ' ' })).not.toHaveProperty('buscar');
    expect(parametrosDe({ buscar: 'l' })).not.toHaveProperty('buscar');
    expect(parametrosDe({ buscar: 'lac' })['buscar']).toBe('lac');
  });

  it('recorta los espacios de la busqueda', () => {
    expect(parametrosDe({ buscar: '  lac  ' })['buscar']).toBe('lac');
  });

  it('la bandera encendida viaja como texto "true"', () => {
    const params = parametrosDe({}, { nombre: 'solo_con_existencia', valor: true });
    expect(params['solo_con_existencia']).toBe('true');
  });

  it('la bandera apagada NO viaja', () => {
    // Mandar `false` no hace dano, pero es un parametro de mas que hay que
    // explicar: no mandarla es la forma de decir "sin filtro".
    const params = parametrosDe({}, { nombre: 'solo_con_saldo', valor: false });
    expect(params).not.toHaveProperty('solo_con_saldo');
  });

  it('sin bandera tampoco viaja nada de mas', () => {
    expect(parametrosDe({ buscar: 'juan', limite: 25, offset: 0 })).toEqual({
      limite: 25,
      offset: 0,
      buscar: 'juan',
    });
  });
});
