import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { excelNotaRemision } from '../../src/modules/notas-remision/excel.js';
import type { ClienteImprimible, Nota } from '../../src/modules/notas-remision/modelo.js';

/**
 * El Excel de la nota de remision.
 *
 * Aqui se prueba el RENDER, no la ruta: `excelNotaRemision` es una funcion
 * pura que recibe la nota y devuelve bytes, asi que se comprueba que sale
 * un `.xlsx` de verdad, con el folio, la fecha, los renglones y el total,
 * sin base de datos ni servidor. Que la ruta lo entregue con los permisos
 * correctos es cosa de `tests/api.test.mjs`.
 *
 * Para leer el Excel generado se RECARGA con ExcelJS, la misma libreria que
 * lo armo: si un blog que exceljs escribe no se puede volver a leer con
 * exceljs, el archivo esta roto, y ademas permite preguntarle a la hoja por
 * sus celdas sin parsear el XML de un ZIP a mano.
 *
 * Que la plantilla exista y este limpia es un supuesto de la funcion: si el
 * archivo `plantillas/nota-remision.xlsx` no esta, `readFile` falla y el
 * test falla con el error de sistema, que es lo que se quiere.
 */

const renglon = (over: Partial<Nota['renglones'][number]> = {}) => ({
  id: 1,
  producto_id: 1,
  producto_codigo: 'LAC',
  producto_nombre: 'VIMILAC 400',
  almacen_id: 1,
  almacen: 'Bodega BUAP',
  cantidad_bultos: 10,
  kg_bulto: 25,
  precio_unit_kg: 37.5,
  subtotal: 9375,
  ...over,
});

const cliente = (over: Partial<ClienteImprimible> = {}): ClienteImprimible => ({
  nombre: 'Granja Los Robles',
  codigo: 'AC01',
  telefono: '(222) 987 6543',
  direccion: 'Camino a la Sierra s/n',
  establo: 'Establo Norte',
  especie: 'Bovinos lecheros',
  rfc: null,
  razon_social: null,
  ...over,
});

const nota = (over: Partial<Nota> = {}): Nota => ({
  id: 1,
  folio_id: 10,
  folio: 'A-1001',
  cliente_id: 1,
  cliente: 'Granja Los Robles',
  vendedor_id: 2,
  vendedor: 'Hermana',
  fecha: '2026-09-27',
  direccion_entrega: null,
  subtotal: 9375,
  estatus: 'pendiente',
  motivo_cancelacion: null,
  creado_en: '2026-09-27T10:00:00.000Z',
  actualizado_en: '2026-09-27T10:00:00.000Z',
  renglones: [renglon()],
  ...over,
});

/** Recarga el buffer como libro de calculo y devuelve la primera hoja. */
const recargar = async (bytes: Buffer): Promise<ExcelJS.Worksheet> => {
  const libro = new ExcelJS.Workbook();
  // `load` espera el `Buffer` que el propio exceljs declara (un ArrayBuffer
  // extendido), no el de Node; en runtime son el mismo objeto, asi que el
  // cast es solo para que los dos tipos se encuentren.
  await libro.xlsx.load(bytes as unknown as ArrayBuffer);
  const hoja = libro.worksheets[0];
  if (hoja === undefined) throw new Error('el libro recargado no trae hoja');
  return hoja;
};

describe('excel de la nota de remision', () => {
  it('arma un xlsx de verdad', async () => {
    const { bytes } = await excelNotaRemision(nota(), cliente());
    // Todo .xlsx (un ZIP) empieza con "PK", los bytes de la firma.
    expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK');
    expect(bytes.byteLength).toBeGreaterThan(10_000);
  });

  it('pone la cabecera: folio, fecha y total', async () => {
    const { bytes } = await excelNotaRemision(nota(), cliente());
    const hoja = await recargar(bytes);

    // La fecha va "27-sep-26" y el total es el de la base, formateado.
    expect(hoja.getCell('B7').value).toBe('A-1001');
    expect(hoja.getCell('E8').value).toBe('27-sep-26');
    expect(hoja.getCell('E40').value).toBe('9,375.00');
  });

  it('escribe el primer renglon en su bloque', async () => {
    const { bytes } = await excelNotaRemision(
      nota({ renglones: [renglon({ cantidad_bultos: 10, kg_bulto: 25, precio_unit_kg: 37.5 })] }),
      cliente(),
    );
    const hoja = await recargar(bytes);
    expect(hoja.getCell('A13').value).toBe('10.00');
    expect(hoja.getCell('D13').value).toBe('25.000');
    expect(hoja.getCell('E13').value).toBe('37.50');
    expect(hoja.getCell('F13').value).toBe('9,375.00');
  });

  it('mueve el segundo renglon al bloque siguiente', async () => {
    const segundo = renglon({ id: 2, producto_nombre: 'MAIZ', cantidad_bultos: 3, subtotal: 600 });
    const { bytes } = await excelNotaRemision(nota({ renglones: [renglon(), segundo] }), cliente());
    const hoja = await recargar(bytes);
    expect(hoja.getCell('B16').value).toBe('MAIZ');
    expect(hoja.getCell('A16').value).toBe('3.00');
  });

  it('usa la direccion de entrega de la nota, no la del cliente', async () => {
    const { bytes } = await excelNotaRemision(
      nota({ direccion_entrega: 'Zacatepec 400' }),
      cliente({ direccion: 'Camino a la Sierra s/n' }),
    );
    const hoja = await recargar(bytes);
    expect(hoja.getCell('B10').value).toBe('Zacatepec 400');
  });

  it('tacha los renglones que la nota no llena', async () => {
    const { bytes } = await excelNotaRemision(nota(), cliente());
    const hoja = await recargar(bytes);

    // La nota trae 1 renglon: el bloque 1 se llena y el 2 se tacha.
    expect(hoja.getCell('A13').value).not.toBeNull();
    expect(hoja.getCell('B13').value).not.toBeNull();

    const bloqueTachado = hoja.getCell('A16');
    expect(bloqueTachado.value).toBeNull();
  });
});
