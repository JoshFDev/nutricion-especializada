import { describe, expect, it } from 'vitest';
import { parametrosEstadoCuenta } from './estado-cuenta-api';

/**
 * Los parametros del listado de estado de cuenta.
 *
 * Se prueba la funcion pura y no la llamada: las reglas del sistema son
 * `strict`, y un parametro de mas da un 400. Por eso lo que importa es QUE se
 * manda y que NO.
 */

describe('los parametros del listado', () => {
  it('por defecto pide los primeros veinticinco, desde el inicio', () => {
    expect(parametrosEstadoCuenta({})).toEqual({ limite: 25, offset: 0 });
  });

  it('respeta el limite y el offset que se le den', () => {
    expect(parametrosEstadoCuenta({ limite: 100, offset: 50 })).toEqual({
      limite: 100,
      offset: 50,
    });
  });

  it('la busqueda solo viaja desde dos caracteres', () => {
    expect(parametrosEstadoCuenta({})).not.toHaveProperty('buscar');
    expect(parametrosEstadoCuenta({ buscar: ' ' })).not.toHaveProperty('buscar');
    expect(parametrosEstadoCuenta({ buscar: 'l' })).not.toHaveProperty('buscar');
    expect(parametrosEstadoCuenta({ buscar: 'lac' })['buscar']).toBe('lac');
  });

  it('recorta los espacios de la busqueda', () => {
    expect(parametrosEstadoCuenta({ buscar: '  lac  ' })['buscar']).toBe('lac');
  });

  it('la bandera encendida viaja como texto "true"', () => {
    expect(parametrosEstadoCuenta({ solo_con_saldo: true })['solo_con_saldo']).toBe('true');
  });

  it('la bandera apagada NO viaja', () => {
    // No mandarla es la forma de decir "sin filtro": mandar `false` seria un
    // parametro de mas que hay que explicar.
    expect(parametrosEstadoCuenta({ solo_con_saldo: false })).not.toHaveProperty('solo_con_saldo');
  });
});
