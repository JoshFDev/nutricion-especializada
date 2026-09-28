import { describe, expect, it } from 'vitest';
import {
  bultosComoTexto,
  decimalComoTexto,
  kilosComoTexto,
  montoComoTexto,
  numeroComoTexto,
  redondearMonto,
} from './cifras';

/**
 * Los numeros que se muestran y los que se mandan.
 *
 * Estas funciones son changudas y aburridas, que es exactamente por que se
 * prueban: un `toFixed` mal puesto no truena la app, deja de poner miles en
 * un total de cien mil pesos y nadie se entera hasta que un cliente lo
 * reclama.
 */
describe('mostrar numeros', () => {
  it('los miles van con coma, que es como se escribe en un papel', () => {
    expect(montoComoTexto(1_234_567.5)).toBe('1,234,567.50');
  });

  it('el decimal es punto, tambien en el papel', () => {
    expect(montoComoTexto(1234.5)).toBe('1,234.50');
  });

  it('el dinero siempre sale con dos decimales', () => {
    expect(montoComoTexto(10)).toBe('10.00');
    expect(montoComoTexto(10.005)).toBe('10.01');
  });

  it('los kilos salen con tres, que es la precision de kg_bulto', () => {
    expect(kilosComoTexto(25.5)).toBe('25.500');
    expect(bultosComoTexto(8.5)).toBe('8.50');
  });

  it('un numero que no es numero se muestra como cero, no como NaN', () => {
    // NaN e Infinity con un separador de miles en medio dicen "NaN,00" e
    // "Infinity", que en un total es peor que no decir nada. El cero sale
    // PELADO, igual que en `core/valores.ts` del backend: es un caso que
    // la base nunca produce (su NUMERIC es exacto) y las dos mitades
    // tienen que decir lo mismo.
    expect(montoComoTexto(Number.NaN)).toBe('0');
    expect(montoComoTexto(Number.POSITIVE_INFINITY)).toBe('0');
  });

  it('el negativo se lleva su signo', () => {
    expect(montoComoTexto(-1_500.5)).toBe('-1,500.50');
  });

  it('un numero sin decimales no inventa el punto', () => {
    expect(numeroComoTexto(1000, 0)).toBe('1,000');
  });
});

describe('mandar numeros', () => {
  it('quita los ceros de mas, que en el JSON son ruido', () => {
    // El backend valida con ^\d{1,8}(\.\d{1,2})?$ y "8.00" lo pasa, pero
    // en el cuerpo de la peticion no aporta nada.
    expect(decimalComoTexto(8.0, 2)).toBe('8');
    expect(decimalComoTexto('8.50', 2)).toBe('8.5');
  });

  it('redondea ANTES de convertir a texto, y no despues', () => {
    // Sin el redondeo previo esto salia "0.30000000000000004" y el backend
    // lo rechazaba por tener demasiados decimales.
    expect(decimalComoTexto(0.1 + 0.2, 2)).toBe('0.3');
    expect(decimalComoTexto(1.005, 2)).toBe('1');
  });

  it('acepta coma, que es como se teclea en un teclado', () => {
    expect(decimalComoTexto('8,5', 2)).toBe('8.5');
  });

  it('lo que no es numero truena con un error que lo dice', () => {
    expect(() => decimalComoTexto('ocho', 2)).toThrow(/no es un numero/);
    // El vacio es el caso que `Number` no ayuda: `Number('')` es 0.
    expect(() => decimalComoTexto('', 2)).toThrow(/vacia/);
    expect(() => decimalComoTexto('   ', 2)).toThrow(/vacia/);
  });

  it('redondea el monto a dos decimales', () => {
    expect(redondearMonto(10.005)).toBe(10.01);
    expect(redondearMonto(0.1 + 0.2)).toBe(0.3);
  });

  it('un total que no es numero no se vuelve Infinity en la pantalla', () => {
    expect(redondearMonto(Number.NaN)).toBe(0);
  });
});
