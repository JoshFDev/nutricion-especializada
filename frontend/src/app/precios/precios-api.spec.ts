import { describe, expect, it } from 'vitest';
import { cuerpoDePrecio, hoyComoTexto, problemaDePrecio, problemaDeVigencia } from './precios-api';

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
