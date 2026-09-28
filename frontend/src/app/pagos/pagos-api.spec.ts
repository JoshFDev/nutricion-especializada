import { describe, expect, it } from 'vitest';
import {
  cuerpoDePago,
  hoyComoTexto,
  montoDeAplicaciones,
  problemaDeAplicacion,
  type AplicacionEditor,
} from './pagos-api';

/**
 * El cuerpo del pago: lo que se manda al backend, y la ayuda del editor.
 *
 * El pago es el contraste del POS: la nota manda solo renglones de
 * producto y el backend cobra el precio vigente; aqui el monto lo teclea
 * la persona y el backend SOLO valida (que alcance el pago, que la nota
 * sea del cliente, que no este cancelada). Por eso el cuerpo es esto:
 * cliente, fecha, metodo opcional, monto, y SOLO las notas que se van a
 * cubrir de verdad.
 */

function aplicacion(parcial: Partial<AplicacionEditor> = {}): AplicacionEditor {
  return {
    nota_id: 1,
    folio: 'A-1001',
    fecha: '2026-09-28',
    subtotal: 1000,
    estatus: 'pendiente',
    monto: '',
    ...parcial,
  };
}

describe('el cuerpo del pago', () => {
  it('lleva la fecha que se eligio, siempre', () => {
    const cuerpo = cuerpoDePago(1, '2026-09-28', null, '500', false, '', []);
    expect(cuerpo.fecha).toBe('2026-09-28');
  });

  it('el monto va normalizado, no como se tecleo', () => {
    const cuerpo = cuerpoDePago(1, '2026-09-28', null, '500.5', false, '', []);
    expect(cuerpo.monto).toBe('500.5');
  });

  it('metodo y referencia vacios son null', () => {
    const cuerpo = cuerpoDePago(1, '2026-09-28', null, '500', false, '   ', []);
    expect(cuerpo.metodo).toBeNull();
    expect(cuerpo.referencia).toBeNull();
  });

  it('lleva solo las notas con monto, en cero no van', () => {
    const cuerpo = cuerpoDePago(1, '2026-09-28', 'Efectivo', '700', false, 'ref', [
      aplicacion({ nota_id: 1, monto: '' }),
      aplicacion({ nota_id: 2, folio: 'A-1002', monto: '700' }),
    ]);
    expect(cuerpo.aplicaciones).toEqual([{ nota_id: 2, monto: '700' }]);
  });

  it('marca si requiere factura', () => {
    const cuerpo = cuerpoDePago(1, '2026-09-28', null, '500', true, '', []);
    expect(cuerpo.requiere_factura).toBe(true);
  });
});

describe('el preview del editor', () => {
  it('suma el monto de las notas, ignorando las vacias', () => {
    const total = montoDeAplicaciones([
      aplicacion({ monto: '300' }),
      aplicacion({ nota_id: 2, folio: 'A-1002', monto: '' }),
      aplicacion({ nota_id: 3, folio: 'A-1003', monto: '250.5' }),
    ]);
    expect(total).toBe(550.5);
  });

  it('respeta una coma como decimal de teclado', () => {
    const total = montoDeAplicaciones([aplicacion({ monto: '250,5' })]);
    expect(total).toBe(250.5);
  });

  it('hoy es AAAA-MM-DD', () => {
    const fecha = new Date(2026, 8, 28);
    expect(hoyComoTexto(fecha)).toBe('2026-09-28');
  });
});

describe('cuando una nota se puede aplicar', () => {
  it('vacia esta lista para aplicarse', () => {
    expect(problemaDeAplicacion(aplicacion({ monto: '' }))).toBeNull();
    expect(problemaDeAplicacion(aplicacion({ monto: '   ' }))).toBeNull();
  });

  it('un numero mayor que cero y dentro del subtotal no tiene problema', () => {
    expect(problemaDeAplicacion(aplicacion({ subtotal: 1000, monto: '700' }))).toBeNull();
  });

  it('cero o menos no tiene sentido', () => {
    expect(problemaDeAplicacion(aplicacion({ monto: '0' }))).not.toBeNull();
    expect(problemaDeAplicacion(aplicacion({ monto: '-5' }))).not.toBeNull();
  });

  it('no puede pasar del subtotal de la nota', () => {
    expect(problemaDeAplicacion(aplicacion({ subtotal: 1000, monto: '1000.01' }))).not.toBeNull();
  });

  it('lo que no es un numero tampoco', () => {
    expect(problemaDeAplicacion(aplicacion({ monto: 'mil' }))).not.toBeNull();
  });
});
