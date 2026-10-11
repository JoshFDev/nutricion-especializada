import { describe, expect, it } from 'vitest';
import { armarMovimientos } from '../../src/modules/estado-cuenta/servicio.js';

/**
 * La mezcla de ventas y abonos del estado de cuenta.
 *
 * `armarMovimientos` es una funcion pura: recibe las dos listas que devuelve el
 * repositorio (ya ordenadas por fecha) y devuelve una sola en orden
 * cronologico. Lo que importa probar es el EMPATE del mismo dia (venta primero,
 * abono despues) y que la fecha salga en el formato del papel.
 */

const venta = (fecha: string, folio_numero: number, monto: string, serie = 'A') => ({
  fecha,
  serie,
  folio_numero: String(folio_numero),
  monto,
});

const abono = (fecha: string, monto: string, metodo: string | null = 'Efectivo') => ({
  fecha,
  metodo,
  monto,
});

describe('armarMovimientos', () => {
  it('mezcla las dos listas en orden cronologico', () => {
    const mezcla = armarMovimientos(
      [venta('2026-09-01', 1001, '500'), venta('2026-09-10', 1002, '300')],
      [abono('2026-09-05', '200')],
    );
    expect(mezcla.map((m) => m.fecha)).toEqual(['01-09-2026', '05-09-2026', '10-09-2026']);
    expect(mezcla.map((m) => m.esAbono)).toEqual([false, true, false]);
  });

  it('en el mismo dia, la venta va antes que el abono', () => {
    // La venta crea la deuda y el abono la paga: en el papel deben verse en
    // ese orden, aunque la base los devuelva en cualquier orden.
    const mezcla = armarMovimientos(
      [venta('2026-09-01', 1001, '500')],
      [abono('2026-09-01', '500')],
    );
    expect(mezcla.map((m) => m.esAbono)).toEqual([false, true]);
  });

  it('arma el folio con la serie y deja vacia la serie en folios numericos', () => {
    const mezcla = armarMovimientos(
      [venta('2026-09-01', 1001, '500'), venta('2026-09-02', 42, '800', '')],
      [],
    );
    expect(mezcla[0]?.folio).toBe('A-1001');
    expect(mezcla[1]?.folio).toBe('42');
  });

  it('convierte el monto a numero y el metodo del abono viaja tal cual', () => {
    const mezcla = armarMovimientos(
      [venta('2026-09-01', 1001, '500.50')],
      [abono('2026-09-02', '120', 'Transferencia')],
    );
    expect(mezcla[0]).toMatchObject({ monto: 500.5, folio: 'A-1001' });
    expect(mezcla[1]).toMatchObject({ monto: 120, metodo: 'Transferencia' });
  });

  it('deja el abono sin metodo cuando la base lo trae nulo', () => {
    // `pagos.metodo` admite NULL. El renglon debe quedar SIN la propiedad, no
    // con un metodo vacio: asi el Excel deja la columna F en blanco.
    const mezcla = armarMovimientos([], [abono('2026-09-01', '100', null)]);
    expect(mezcla[0]).toMatchObject({ esAbono: true, monto: 100 });
    expect(mezcla[0]?.metodo).toBeUndefined();
    expect('metodo' in (mezcla[0] ?? {})).toBe(false);
  });

  it('con una lista vacia devuelve la otra', () => {
    expect(armarMovimientos([], [abono('2026-09-01', '10')])).toHaveLength(1);
    expect(armarMovimientos([venta('2026-09-01', 1, '10')], [])).toHaveLength(1);
    expect(armarMovimientos([], [])).toEqual([]);
  });
});
