import { describe, expect, it } from 'vitest';
import {
  cuerpoDeCuenta,
  cuerpoDeMovimiento,
  problemaDeCategoria,
  problemaDeDescripcion,
  problemaDeMonto,
  problemaDeNombreCuenta,
  saldoNegativo,
  totalesDeResumen,
  unaLinea,
  type EditorMovimiento,
  type ResumenCuenta,
} from './caja-api';

/**
 * Las reglas que la pantalla decide por su cuenta, y el cuerpo que se manda.
 *
 * Lo importante aqui es que la pantalla no mande nunca un `saldo_actual` y que
 * respete los limites del esquema: `decimal(10, 2)` y mayor que cero para el
 * monto, 80 caracteres para la categoria, y el banco obligatorio cuando el tipo
 * de cuenta es `banco`. Un `saldo_actual` en el cuerpo se rechazaria con un
 * 400 de "propiedad inesperada", y un saldo escrito a mano se pisaria con el
 * siguiente movimiento sin avisar.
 */

function editor(over: Partial<EditorMovimiento> = {}): EditorMovimiento {
  return {
    cuenta_id: 1,
    tipo: 'egreso',
    categoria: 'Renta del local',
    monto: '1500',
    ...over,
  };
}

describe('el cuerpo del movimiento', () => {
  it('nunca manda el saldo: lo recalcula el trigger', () => {
    const cuerpo = cuerpoDeMovimiento(editor(), null, null, '', '', false);
    expect(cuerpo).not.toHaveProperty('saldo_actual');
  });

  it('el monto va como texto, sin miles y sin ceros de mas', () => {
    expect(cuerpoDeMovimiento(editor({ monto: '1,500.50' }), null, null, '', '', false).monto).toBe(
      '1500.5',
    );
    expect(cuerpoDeMovimiento(editor({ monto: ' 8.50 ' }), null, null, '', '', false).monto).toBe(
      '8.5',
    );
    expect(cuerpoDeMovimiento(editor({ monto: '1500,50' }), null, null, '', '', false).monto).toBe(
      '1500.5',
    );
  });

  it('la fecha vacia se omite y la de hoy la pone el backend', () => {
    expect(cuerpoDeMovimiento(editor(), null, null, '', '', false).fecha).toBeUndefined();
    expect(cuerpoDeMovimiento(editor(), null, null, '2026-09-28', '', false).fecha).toBe(
      '2026-09-28',
    );
  });

  it('un movimiento no es de cliente y de proveedor a la vez', () => {
    const cuerpo = cuerpoDeMovimiento(editor(), { id: 3, nombre: 'Karla' }, null, '', '', false);
    expect(cuerpo.cliente_id).toBe(3);
    expect(cuerpo.proveedor_id).toBeNull();
  });

  it('los dos vacios es legitimo: la renta del local no es de nadie', () => {
    const cuerpo = cuerpoDeMovimiento(editor(), null, null, '', '', false);
    expect(cuerpo.cliente_id).toBeNull();
    expect(cuerpo.proveedor_id).toBeNull();
  });

  it('la descripcion vacia es null, no un texto en blanco', () => {
    expect(cuerpoDeMovimiento(editor(), null, null, '', '   ', false).descripcion).toBeNull();
    expect(
      cuerpoDeMovimiento(editor(), null, null, '', '  recibo de luz  ', false).descripcion,
    ).toBe('recibo de luz');
  });

  it('sin cuenta no se arma nada: el esquema la pide', () => {
    expect(() =>
      cuerpoDeMovimiento(editor({ cuenta_id: null }), null, null, '', '', false),
    ).toThrow();
  });
});

describe('el monto', () => {
  it('acepta hasta 10 enteros y 2 decimales, que es el decimal(10, 2) del esquema', () => {
    expect(problemaDeMonto('1234567890.99')).toBeNull();
    expect(problemaDeMonto('12345678901')).not.toBeNull();
    expect(problemaDeMonto('8.505')).not.toBeNull();
  });

  it('rechaza el cero y el negativo, como el CHECK de la base', () => {
    expect(problemaDeMonto('0')).not.toBeNull();
    expect(problemaDeMonto('0.00')).not.toBeNull();
    expect(problemaDeMonto('-5')).not.toBeNull();
  });

  it('acepta la coma de miles y la decimal, que son las dos que se teclean', () => {
    expect(problemaDeMonto('1,500.50')).toBeNull();
    expect(problemaDeMonto('1500,50')).toBeNull();
    expect(problemaDeMonto('1,500')).toBeNull();
    // El punto de millar no: "1.500" son tres decimales, y la pantalla
    // muestra los miles con coma, asi que esa forma no sale de aqui.
    expect(problemaDeMonto('1.500')).not.toBeNull();
  });

  it('rechaza lo que no es un numero antes de que lo rechace el servidor', () => {
    expect(problemaDeMonto('')).not.toBeNull();
    expect(problemaDeMonto('mil')).not.toBeNull();
  });
});

describe('los textos cortos', () => {
  it('la categoria necesita dos caracteres y no pasa de 80', () => {
    expect(problemaDeCategoria('Renta')).toBeNull();
    expect(problemaDeCategoria('R')).not.toBeNull();
    expect(problemaDeCategoria('R'.repeat(81))).not.toBeNull();
    expect(problemaDeCategoria('R'.repeat(80))).toBeNull();
  });

  it('la descripcion se acota a 300, que es el maximo del esquema', () => {
    expect(problemaDeDescripcion('x'.repeat(300))).toBeNull();
    expect(problemaDeDescripcion('x'.repeat(301))).not.toBeNull();
  });

  it('el nombre de la cuenta pide dos, aunque el servidor no los pida', () => {
    expect(problemaDeNombreCuenta('Caja chica')).toBeNull();
    expect(problemaDeNombreCuenta('C')).not.toBeNull();
    expect(problemaDeNombreCuenta('C'.repeat(121))).not.toBeNull();
  });

  it('una linea: el esquema rechaza los saltos de linea', () => {
    expect(unaLinea('recibo\nde luz')).toBe('recibo de luz');
    expect(problemaDeDescripcion('a\nb')).toBeNull();
  });
});

describe('el alta de cuenta', () => {
  it('una cuenta de banco necesita el banco', () => {
    expect(() => cuerpoDeCuenta('Cuenta del banco', 'banco', '', 'Pablo')).toThrow();
    expect(cuerpoDeCuenta('Cuenta del banco', 'banco', 'BBVA', 'Pablo').banco).toBe('BBVA');
  });

  it('una de efectivo no lleva banco, aunque se escriba', () => {
    expect(cuerpoDeCuenta('Caja chica', 'efectivo', '', '').banco).toBeNull();
  });

  it('el titular vacio es null', () => {
    expect(cuerpoDeCuenta('Caja chica', 'efectivo', '', '   ').titular).toBeNull();
  });
});

describe('los saldos', () => {
  it('el negativo se pinta en rojo, y da igual el tipo del movimiento', () => {
    expect(saldoNegativo(-0.01)).toBe(true);
    expect(saldoNegativo(0)).toBe(false);
  });
});

describe('los totales del periodo', () => {
  function resumen(over: Partial<ResumenCuenta>): ResumenCuenta {
    return {
      cuenta_id: 1,
      cuenta: 'Caja chica',
      tipo: 'efectivo',
      ingresos: 0,
      egresos: 0,
      saldo_periodo: 0,
      saldo_actual: 0,
      movimientos: 0,
      ...over,
    };
  }

  it('suma entrada, salida y la diferencia de todas las cuentas', () => {
    const totales = totalesDeResumen([
      resumen({ ingresos: 1000, egresos: 400, saldo_periodo: 600 }),
      resumen({ ingresos: 250, egresos: 900, saldo_periodo: -650 }),
    ]);
    expect(totales).toEqual({ ingresos: 1250, egresos: 1300, saldo: -50 });
  });

  it('sin cuentas son cero, no NaN', () => {
    expect(totalesDeResumen([])).toEqual({ ingresos: 0, egresos: 0, saldo: 0 });
  });

  it('el saldo del periodo se suma con redondeo de centavo', () => {
    const totales = totalesDeResumen([
      resumen({ ingresos: 0.1, egresos: 0, saldo_periodo: 0.1 }),
      resumen({ ingresos: 0.2, egresos: 0, saldo_periodo: 0.2 }),
    ]);
    expect(totales.saldo).toBe(0.3);
  });
});
