import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { excelEstadoCuentaGeneral } from '../../src/modules/estado-cuenta/excel-general.js';

/**
 * El Excel del estado de cuenta GENERAL (el de todos los clientes).
 *
 * La plantilla real (`plantillas/EstadoCuentaGeneral.xlsx`) trae una tabla
 * ("SALDO2") con autofiltro. Eso es lo que rompia el archivo: ExcelJS la
 * recargaba y al reescribir el libro emitia un `table1.xml` invalido, asi que
 * Excel pedia reparar el contenido. Aqui se blinda que el archivo generado ya
 * no traiga tabla, ademas de los datos de siempre.
 */

const recargar = async (bytes: Buffer): Promise<ExcelJS.Worksheet> => {
  const libro = new ExcelJS.Workbook();
  await libro.xlsx.load(bytes as unknown as ArrayBuffer);
  const hoja = libro.worksheets[0];
  if (hoja === undefined) throw new Error('el libro recargado no trae hoja');
  return hoja;
};

const tablaDe = (hoja: ExcelJS.Worksheet): Record<string, unknown> =>
  (hoja as unknown as { tables: Record<string, unknown> }).tables;

describe('excel del estado de cuenta general', () => {
  it('arma un xlsx de verdad', async () => {
    const { bytes } = await excelEstadoCuentaGeneral([
      { cliente: 'Granja Los Robles', saldo_actual: 100 },
    ]);
    // Todo .xlsx (un ZIP) empieza con "PK", los bytes de la firma.
    expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK');
  });

  it('no deja la tabla de la plantilla, que es la que rompia el archivo', async () => {
    const { bytes } = await excelEstadoCuentaGeneral([
      { cliente: 'Granja Los Robles', saldo_actual: 100 },
    ]);

    const hoja = await recargar(bytes);
    expect(Object.keys(tablaDe(hoja))).toHaveLength(0);
    // Ni siquiera debe viajar la parte `xl/tables/...` dentro del ZIP.
    expect(bytes.includes('xl/tables/')).toBe(false);
  });

  it('escribe los saldos y su total', async () => {
    const { bytes, escritos } = await excelEstadoCuentaGeneral([
      { cliente: 'Granja Los Robles', saldo_actual: 9375 },
      { cliente: 'Rancho El Sol', saldo_actual: 625 },
    ]);
    expect(escritos).toBe(2);

    const hoja = await recargar(bytes);
    expect(hoja.getCell('B8').value).toBe('Granja Los Robles');
    expect(hoja.getCell('C8').value).toBe(9375);
    expect(hoja.getCell('B9').value).toBe('Rancho El Sol');
    expect(hoja.getCell('C9').value).toBe(625);
    expect(hoja.getCell('B26').value).toBe('Total');
    expect(hoja.getCell('C26').value).toBe(10000);
  });

  it('cuenta los clientes que no caben en las filas del papel', async () => {
    const muchos = Array.from({ length: 20 }, (_, i) => ({
      cliente: `Cliente ${i}`,
      saldo_actual: 10,
    }));
    const { escritos, renglonesFuera } = await excelEstadoCuentaGeneral(muchos);
    expect(escritos).toBe(18);
    expect(renglonesFuera).toBe(2);
  });
});
