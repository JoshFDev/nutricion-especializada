import { describe, expect, it } from 'vitest';
import { parametrosDe, parametrosDeMovimientos } from './inventario-api';

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

/**
 * Los parametros del kardex.
 *
 * A diferencia de la existencia, aquí el producto y el almacen son
 * OBLIGATORIOS: esta pantalla nunca pregunta por "todos los movimientos", solo
 * por los de la combinación que se ajusta. El tipo es opcional.
 */
describe('los parametros del kardex', () => {
  it('manda siempre el producto y el almacen', () => {
    expect(parametrosDeMovimientos({ producto_id: 7, almacen_id: 2 })).toMatchObject({
      producto_id: 7,
      almacen_id: 2,
    });
  });

  it('pide cincuenta por defecto, desde el inicio', () => {
    expect(parametrosDeMovimientos({ producto_id: 7, almacen_id: 2 })).toMatchObject({
      limite: 50,
      offset: 0,
    });
  });

  it('el tipo solo viaja cuando se pidio', () => {
    expect(parametrosDeMovimientos({ producto_id: 7, almacen_id: 2 })).not.toHaveProperty('tipo');
    expect(parametrosDeMovimientos({ producto_id: 7, almacen_id: 2, tipo: 'merma' })['tipo']).toBe(
      'merma',
    );
  });
});
