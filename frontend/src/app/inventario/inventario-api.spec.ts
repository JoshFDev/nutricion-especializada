import { describe, expect, it } from 'vitest';
import { parametrosDe } from './inventario-api';

/**
 * Los parametros de la lista de inventario.
 *
 * Se prueba la funcion pura y no la llamada: el esquema del backend es
 * `strict`, y un parametro de mas da un 400. Por eso lo que importa es QUE se
 * manda y que NO: sobre todo que "todas" no manda `vacios`, porque el
 * backend lo lee como booleano y un string vacio reventaria el listado.
 */

describe('los parametros de la existencia', () => {
  it('por defecto pide los primeros cincuenta, desde el inicio', () => {
    expect(parametrosDe({})).toEqual({ limite: 50, offset: 0 });
  });

  it('"todas" no manda vacios', () => {
    const params = parametrosDe({ existencia: 'todas' });
    expect(params).not.toHaveProperty('vacios');
  });

  it('"con" pide vacios=false y "vacios" pide vacios=true', () => {
    expect(parametrosDe({ existencia: 'con' })['vacios']).toBe('false');
    expect(parametrosDe({ existencia: 'vacios' })['vacios']).toBe('true');
  });

  it('la busqueda solo viaja cuando hay texto', () => {
    expect(parametrosDe({})).not.toHaveProperty('buscar');
    expect(parametrosDe({ buscar: 'lac' })['buscar']).toBe('lac');
  });

  it('el producto y el almacen van como numeros, y el cero cuenta', () => {
    const params = parametrosDe({ producto_id: 0, almacen_id: 2 });
    expect(params['producto_id']).toBe(0);
    expect(params['almacen_id']).toBe(2);
  });

  it('respeta el limite y el offset que se le den', () => {
    expect(parametrosDe({ limite: 10, offset: 40 })).toMatchObject({ limite: 10, offset: 40 });
  });
});
