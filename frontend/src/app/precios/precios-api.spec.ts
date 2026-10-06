import { describe, expect, it } from 'vitest';
import {
  cuerpoDePrecio,
  criteriosDe,
  hoyComoTexto,
  problemaDePrecio,
  problemaDeVigencia,
} from './precios-api';

/**
 * Las reglas del precio: el cuerpo normalizado que se manda y las que el
 * frontend SI puede decidir sola.
 *
 * El precio es el contraste del modulo: la regla de fondo (se traslapa o
 * no con otros) la decide el backend con su trigger; aqui solo se cuida
 * que el TEXTO que se manda sea el que el esquema acepta — el numero con
 * hasta dos decimales y la vigencia con orden.
 */

describe('el cuerpo de un precio', () => {
  it('normaliza el precio como el esquema lo espera', () => {
    const cuerpo = cuerpoDePrecio('8.50', '2026-09-28', '');
    expect(cuerpo.precio_kg).toBe('8.5');
    expect(cuerpo.vigente_desde).toBe('2026-09-28');
  });

  it('una coma del teclado es un punto decimal', () => {
    const cuerpo = cuerpoDePrecio('8,50', '2026-09-28', '');
    expect(cuerpo.precio_kg).toBe('8.5');
  });

  it('vigente_hasta vacio es null (abierto)', () => {
    const cuerpo = cuerpoDePrecio('8.5', '2026-09-28', '   ');
    expect(cuerpo.vigente_hasta).toBeNull();
  });

  it('vigente_hasta se manda cuando hay', () => {
    const cuerpo = cuerpoDePrecio('8.5', '2026-09-28', '2026-12-31');
    expect(cuerpo.vigente_hasta).toBe('2026-12-31');
  });
});

describe('cuando un precio esta bien escrito', () => {
  it('un numero con dos decimales no tiene problema', () => {
    expect(problemaDePrecio('8.5')).toBeNull();
  });

  it('vacio no es un error: se avisa aparte', () => {
    expect(problemaDePrecio('')).toBeNull();
  });

  it('no puede ser negativo ni tener mas de dos decimales', () => {
    expect(problemaDePrecio('-1')).not.toBeNull();
    expect(problemaDePrecio('8.505')).not.toBeNull();
  });
});

describe('cuando una vigencia esta en orden', () => {
  it('desde sin hasta es valido', () => {
    expect(problemaDeVigencia('2026-09-28', '')).toBeNull();
  });

  it('la fecha de inicio es obligatoria', () => {
    expect(problemaDeVigencia('', '')).not.toBeNull();
  });

  it('no puede terminar antes de empezar', () => {
    expect(problemaDeVigencia('2026-09-28', '2026-09-27')).not.toBeNull();
  });
});

describe('la fecha de hoy', () => {
  it('es AAAA-MM-DD', () => {
    const fecha = new Date(2026, 8, 28);
    expect(hoyComoTexto(fecha)).toBe('2026-09-28');
  });
});

/**
 * Los query params de cada listado.
 *
 * Los dos listados validan con `strictObject`, asi que sobra una clave rompe
 * la pantalla con un 400. Este caso ya paso: `cliente_id` se mandaba a los dos
 * listados, y como el filtro de cliente no se quitaba al cambiar de pestana,
 * filtrar por un cliente y pasar a "Precio de lista" dejaba el listado en
 * blanco.
 */
describe('los criterios de cada vista', () => {
  const filtros = {
    productoId: 7,
    clienteId: 3,
    vigencia: 'vigentes' as const,
    limite: 50,
    pagina: 1,
  };

  it('el precio de lista NO lleva cliente_id: su esquema lo rechaza', () => {
    const criterios = criteriosDe('publicos', filtros);
    expect(criterios.cliente_id).toBeUndefined();
    // Lo que si acepta, si esta.
    expect(criterios.producto_id).toBe(7);
    expect(criterios.vigencia).toBe('vigentes');
  });

  it('el precio de cliente si lleva cliente_id', () => {
    expect(criteriosDe('clientes', filtros).cliente_id).toBe(3);
  });

  it('ambos llevan el producto, que si lo aceptan los dos', () => {
    expect(criteriosDe('publicos', filtros).producto_id).toBe(7);
    expect(criteriosDe('clientes', filtros).producto_id).toBe(7);
  });

  it('un filtro que no esta puesto no viaja: no se manda la clave', () => {
    const criterios = criteriosDe('clientes', {
      ...filtros,
      productoId: undefined,
      clienteId: undefined,
    });
    expect(criterios.producto_id).toBeUndefined();
    expect(criterios.cliente_id).toBeUndefined();
  });

  it('el offset sale de la pagina y el limite, y la primera pagina es 0', () => {
    expect(criteriosDe('publicos', { ...filtros, pagina: 1, limite: 50 }).offset).toBe(0);
    expect(criteriosDe('publicos', { ...filtros, pagina: 3, limite: 50 }).offset).toBe(100);
    // Cambiar el tamano de pagina devuelve a la 1: por eso el offset se
    // calcula aqui y no se guarda en la pantalla.
    expect(criteriosDe('publicos', { ...filtros, pagina: 1, limite: 25 }).offset).toBe(0);
  });

  it('la vigencia se manda siempre, para que sea el backend el que decida', () => {
    expect(criteriosDe('publicos', { ...filtros, vigencia: 'historicos' }).vigencia).toBe(
      'historicos',
    );
    expect(criteriosDe('clientes', { ...filtros, vigencia: 'todos' }).vigencia).toBe('todos');
  });
});
