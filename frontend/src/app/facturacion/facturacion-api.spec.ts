import { describe, expect, it } from 'vitest';
import {
  cuerpoDeEstatus,
  cuerpoDeFactura,
  cuantasElegidas,
  estatusComoTexto,
  estatusNotaComoTexto,
  montoDeNotas,
  puedePasarA,
  problemaDeMotivo,
  type NotaPorFacturar,
} from './facturacion-api';

/**
 * El cuerpo de la factura y las reglas de la pantalla.
 *
 * Lo que mas importa que este cubierto: que el cuerpo NO lleve `monto_total`
 * (el esquema es `strict` y el total lo calcula el servidor sumando los
 * subtotales) y que solo vayan las notas marcadas. Lo demas son las
 * transiciones de estatus, que aqui no son una regla de negocio sino la
 * decision de que botones se ven: el backend sigue siendo el que manda.
 */

function nota(over: Partial<NotaPorFacturar> = {}): NotaPorFacturar {
  return {
    nota_id: 1,
    folio: 'A-1001',
    fecha: '2026-09-28',
    subtotal: 1000,
    estatus: 'pendiente',
    elegida: true,
    ...over,
  };
}

describe('el cuerpo de la factura', () => {
  it('lleva solo las notas marcadas', () => {
    const cuerpo = cuerpoDeFactura(7, '', '', [
      nota({ nota_id: 1 }),
      nota({ nota_id: 2, elegida: false }),
      nota({ nota_id: 3 }),
    ]);
    expect(cuerpo.notas).toEqual([1, 3]);
  });

  it('nunca manda el monto total: lo calcula el servidor', () => {
    const cuerpo = cuerpoDeFactura(7, '', '', [nota()]);
    expect(cuerpo).not.toHaveProperty('monto_total');
  });

  it('sin notas marcadas no se manda nada: el esquema pide al menos una', () => {
    expect(() => cuerpoDeFactura(7, '', '', [nota({ elegida: false })])).toThrow();
    expect(() => cuerpoDeFactura(7, '', '', [])).toThrow();
  });

  it('la forma de pago vacia es null, no un texto en blanco', () => {
    expect(cuerpoDeFactura(7, '', '   ', [nota()]).metodo_pago).toBeNull();
  });

  it('la forma de pago se manda recortada', () => {
    expect(cuerpoDeFactura(7, '', '  03  ', [nota()]).metodo_pago).toBe('03');
  });

  it('la fecha vacia se omite y la de hoy la pone el backend', () => {
    expect(cuerpoDeFactura(7, '', '', [nota()]).fecha).toBeUndefined();
    expect(cuerpoDeFactura(7, '2026-09-28', '', [nota()]).fecha).toBe('2026-09-28');
  });
});

describe('el preview del total', () => {
  it('suma solo las notas marcadas', () => {
    const total = montoDeNotas([
      nota({ nota_id: 1, subtotal: 1000 }),
      nota({ nota_id: 2, subtotal: 500, elegida: false }),
      nota({ nota_id: 3, subtotal: 250.5 }),
    ]);
    expect(total).toBe(1250.5);
  });

  it('cuenta cuantas van, que es lo que dice el boton', () => {
    expect(cuantasElegidas([nota(), nota({ elegida: false }), nota({ nota_id: 3 })])).toBe(2);
  });
});

describe('las transiciones de estatus', () => {
  it('una solicitada se puede emitir o cancelar', () => {
    expect(puedePasarA('solicitada', 'emitida')).toBe(true);
    expect(puedePasarA('solicitada', 'cancelada')).toBe(true);
  });

  it('una emitida ya no se emite, solo se cancela', () => {
    expect(puedePasarA('emitida', 'emitida')).toBe(false);
    expect(puedePasarA('emitida', 'cancelada')).toBe(true);
  });

  it('una cancelada no sale de ahi: se pide otra', () => {
    expect(puedePasarA('cancelada', 'solicitada')).toBe(false);
    expect(puedePasarA('cancelada', 'emitida')).toBe(false);
    expect(puedePasarA('cancelada', 'cancelada')).toBe(false);
  });
});

describe('el motivo de la cancelacion', () => {
  it('hace falta, y el backend tambien lo pide', () => {
    expect(problemaDeMotivo('')).not.toBeNull();
    expect(problemaDeMotivo('   ')).not.toBeNull();
    expect(problemaDeMotivo('Se emitió mal el CFDI')).toBeNull();
  });

  it('viaja recortado, y vacio es null', () => {
    expect(cuerpoDeEstatus('cancelada', '  error en el RFC  ').motivo).toBe('error en el RFC');
    expect(cuerpoDeEstatus('emitida', '').motivo).toBeNull();
  });
});

describe('los textos de la tabla', () => {
  it('el estatus de la factura se escribe con mayuscula', () => {
    expect(estatusComoTexto('solicitada')).toBe('Solicitada');
    expect(estatusComoTexto('emitida')).toBe('Emitida');
    expect(estatusComoTexto('cancelada')).toBe('Cancelada');
  });

  it('el de la nota pide otra palabra: "parcial" solo no dice que paso', () => {
    expect(estatusNotaComoTexto('pendiente')).toBe('Por pagar');
    expect(estatusNotaComoTexto('parcial')).toBe('Pago parcial');
    expect(estatusNotaComoTexto('pagada')).toBe('Pagada');
  });
});
