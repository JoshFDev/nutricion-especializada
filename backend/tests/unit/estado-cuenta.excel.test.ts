import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { excelEstadoCuenta } from '../../src/modules/estado-cuenta/excel.js';
import { PRIMERA_FILA, ULTIMA_FILA } from '../../src/modules/estado-cuenta/plantilla.js';
import type { HojaCliente, Movimiento } from '../../src/modules/estado-cuenta/modelo.js';

/**
 * El Excel del estado de cuenta.
 *
 * Aqui se prueba el RENDER, no la ruta: `excelEstadoCuenta` es una funcion pura
 * que recibe la cuenta ya armada y devuelve bytes, asi que se comprueba que
 * sale un `.xlsx` de verdad, con el nombre del cliente, los renglones de venta
 * y abono, los totales y el area de impresion, sin base ni servidor. Que la
 * ruta lo entregue con el permiso correcto es cosa de la integracion.
 *
 * Para leerlo se RECARGA con ExcelJS, la misma libreria que lo armo: si un
 * blob que exceljs escribe no se puede volver a leer con exceljs, el archivo
 * esta roto.
 *
 * Que la plantilla este limpia es un supuesto de la funcion. La real
 * (`plantillas/EstadoCuentaCliente.xlsx`) no se versiona; si no esta,
 * `leerPlantilla` cae al `.example.xlsx` versionado, asi que la prueba corre en
 * un clon limpio.
 */

const venta = (fecha: string, folio: string, monto: number): Movimiento => ({
  fecha,
  esAbono: false,
  folio,
  monto,
});

const abono = (fecha: string, metodo: string, monto: number): Movimiento => ({
  fecha,
  esAbono: true,
  metodo,
  monto,
});

const cuenta = (movimientos: Movimiento[] = [], cliente = 'Granja Los Robles'): HojaCliente => ({
  cliente_id: 1,
  cliente,
  movimientos,
});

/** Recarga el buffer como libro de calculo y devuelve la primera hoja. */
const recargar = async (bytes: Buffer): Promise<ExcelJS.Worksheet> => {
  const libro = new ExcelJS.Workbook();
  await libro.xlsx.load(bytes as unknown as ArrayBuffer);
  const hoja = libro.worksheets[0];
  if (hoja === undefined) throw new Error('el libro recargado no trae hoja');
  return hoja;
};

/** La formula de una celda, o cadena vacia si no la trae. */
const formulaDe = (celda: ExcelJS.Cell): string => {
  const valor = celda.value;
  if (valor !== null && typeof valor === 'object' && 'formula' in valor) {
    return String((valor as { formula: string }).formula);
  }
  return '';
};

describe('excel del estado de cuenta', () => {
  it('arma un xlsx de verdad', async () => {
    const { bytes } = await excelEstadoCuenta(cuenta());
    // Todo .xlsx (un ZIP) empieza con "PK", los bytes de la firma.
    expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK');
    expect(bytes.byteLength).toBeGreaterThan(5_000);
  });

  it('pone el nombre del cliente en la celda grande', async () => {
    const { bytes } = await excelEstadoCuenta(cuenta([], 'Granja Los Robles'));
    const hoja = await recargar(bytes);
    expect(hoja.getCell('C4').value).toBe('Granja Los Robles');
  });

  it('escribe una venta en la mitad izquierda del renglon', async () => {
    const { bytes } = await excelEstadoCuenta(cuenta([venta('27-09-2026', 'A-1001', 9375)]));
    const hoja = await recargar(bytes);

    // Fila 8: B fecha, C folio, D monto.
    expect(hoja.getCell('B8').value).toBe('27-09-2026');
    expect(hoja.getCell('C8').value).toBe('A-1001');
    expect(hoja.getCell('D8').value).toBe(9375);
    // La mitad derecha del mismo renglon queda vacia.
    expect(hoja.getCell('E8').value).toBeFalsy();
  });

  it('escribe un abono en la mitad derecha del renglon', async () => {
    const { bytes } = await excelEstadoCuenta(cuenta([abono('28-09-2026', 'Efectivo', 500)]));
    const hoja = await recargar(bytes);

    // Fila 8: E fecha, F metodo, G monto.
    expect(hoja.getCell('E8').value).toBe('28-09-2026');
    expect(hoja.getCell('F8').value).toBe('Efectivo');
    expect(hoja.getCell('G8').value).toBe(500);
    expect(hoja.getCell('B8').value).toBeFalsy();
  });

  it('va rellenando las filas del papel en orden', async () => {
    const { bytes } = await excelEstadoCuenta(
      cuenta([venta('27-09-2026', 'A-1', 100), abono('28-09-2026', 'Efectivo', 50)]),
    );
    const hoja = await recargar(bytes);
    expect(hoja.getCell(`C${PRIMERA_FILA}`).value).toBe('A-1');
    expect(hoja.getCell(`F${PRIMERA_FILA + 1}`).value).toBe('Efectivo');
  });

  it('pone los totales como formula, no como resultado viejo', async () => {
    const { bytes } = await excelEstadoCuenta(cuenta());
    const hoja = await recargar(bytes);

    expect(formulaDe(hoja.getCell('D28'))).toBe(`SUM(D${PRIMERA_FILA}:D${ULTIMA_FILA})`);
    expect(formulaDe(hoja.getCell('G28'))).toBe(`SUM(G${PRIMERA_FILA}:G${ULTIMA_FILA})`);
    expect(formulaDe(hoja.getCell('G29'))).toBe('D28-G28');
  });

  it('imprime solo la cabecera, los renglones y el saldo', async () => {
    const { bytes } = await excelEstadoCuenta(cuenta());
    const hoja = await recargar(bytes);
    expect(hoja.pageSetup.printArea).toBe('B2:G29');
    expect(hoja.pageSetup.fitToPage).toBe(true);
    expect(hoja.pageSetup.fitToWidth).toBe(1);
    expect(hoja.pageSetup.fitToHeight).toBe(1);
  });

  it('cuenta los movimientos que no caben en las veinte filas', async () => {
    const muchos = Array.from({ length: 23 }, (_, i) => venta('27-09-2026', `A-${1000 + i}`, 100));
    const { bytes, renglonesFuera } = await excelEstadoCuenta(cuenta(muchos));
    expect(renglonesFuera).toBe(3);

    // Solo caben 20: la fila 27 es la ultima con datos y la 28 ya es la de
    // totales. El folio 21 nunca se escribe, y la columna de fecha de esa fila
    // queda vacia.
    const hoja = await recargar(bytes);
    expect(hoja.getCell(`C${ULTIMA_FILA}`).value).toBe('A-1019');
    expect(hoja.getCell(`B${ULTIMA_FILA + 1}`).value).toBeFalsy();
    expect(hoja.getCell(`C${ULTIMA_FILA + 1}`).value).toBe('Total');
  });

  it('no cuenta de mas cuando la cuenta cabe completa', async () => {
    const { renglonesFuera } = await excelEstadoCuenta(cuenta([venta('27-09-2026', 'A-1', 100)]));
    expect(renglonesFuera).toBe(0);
  });
});
