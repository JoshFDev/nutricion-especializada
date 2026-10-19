import { describe, expect, it } from 'vitest';
import { momento } from '../../src/core/valores.js';

/**
 * Pruebas del corte de caja: el validador `momento` y su esquema.
 *
 * Son logica pura, asi que corren sin base ni servidor. Lo que importa aqui es
 * el TEXTO: el corte filtra por `creado_en`, una marca con hora, y un momento
 * mal formado o una hora que `Date` normalizaria en silencio (las 25:00) harian
 * que la ventana cayera en otro lado sin avisar.
 */

describe('momento', () => {
  const valida = (v: string) => momento('desde').parse(v);

  it('normaliza la `T` del datetime-local a espacio', () => {
    expect(valida('2026-10-14T08:30')).toBe('2026-10-14 08:30');
  });

  it('acepta el espacio, que es como lo devuelve la base', () => {
    expect(valida('2026-10-14 08:30')).toBe('2026-10-14 08:30');
  });

  it('acepta la medianoche y el ultimo minuto del dia', () => {
    expect(valida('2026-10-14T00:00')).toBe('2026-10-14 00:00');
    expect(valida('2026-10-14T23:59')).toBe('2026-10-14 23:59');
  });

  it.each([
    ['sin hora', '2026-10-14'],
    ['con segundos', '2026-10-14T08:30:00'],
    ['hora de un digito', '2026-10-14T8:30'],
    ['mes de un digito', '2026-1-14T08:30'],
    ['hora 24', '2026-10-14T24:00'],
    ['hora 25', '2026-10-14T25:00'],
    ['minuto 60', '2026-10-14T08:60'],
    ['dia que no existe', '2026-02-30T08:00'],
    ['mes 13', '2026-13-01T08:00'],
    ['texto suelto', 'ayer por la tarde'],
  ])('rechaza: %s', (_nombre, malo) => {
    expect(() => valida(malo)).toThrow();
  });
});

