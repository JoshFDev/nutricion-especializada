import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { excelListaProveedores } from '../../src/modules/proveedores/excel.js';
import type { ProveedorListado } from '../../src/modules/proveedores/modelo.js';

/**
 * El Excel del listado de proveedores.
 *
 * Igual que el de clientes: se prueba el RENDER, que es una funcion pura, y
 * el archivo se recarga con ExcelJS para leer sus celdas.
 */

const proveedor = (over: Partial<ProveedorListado> = {}): ProveedorListado => ({
  id: 1,
  nombre: 'Forrajeros del Norte',
  contacto: 'Laura Mendez',
  telefono: '(614) 123 4567',
  saldo_actual: 8300,
  activo: true,
  compras: 7,
  ...over,
});

const recargar = async (bytes: Buffer): Promise<ExcelJS.Worksheet> => {
  const libro = new ExcelJS.Workbook();
  await libro.xlsx.load(bytes as unknown as ArrayBuffer);
  const hoja = libro.worksheets[0];
  if (hoja === undefined) throw new Error('el libro recargado no trae hoja');
  return hoja;
};

describe('excel de la lista de proveedores', () => {
  it('arma un xlsx de verdad', async () => {
    const bytes = await excelListaProveedores([proveedor()]);
    expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK');
  });

  it('pone las cabeceras en el orden de la tabla', async () => {
    const hoja = await recargar(await excelListaProveedores([proveedor()]));

    const cabeceras = hoja.getRow(1).values as unknown[];
    expect(cabeceras.slice(1)).toEqual([
      'Nombre',
      'Contacto',
      'Telefono',
      'Saldo',
      'Compras',
      'Estado',
    ]);
  });

  it('escribe la fila con los datos del proveedor', async () => {
    const hoja = await recargar(await excelListaProveedores([proveedor()]));

    expect(hoja.getCell('A2').value).toBe('Forrajeros del Norte');
    expect(hoja.getCell('B2').value).toBe('Laura Mendez');
    expect(hoja.getCell('C2').value).toBe('(614) 123 4567');
    expect(hoja.getCell('F2').value).toBe('Activo');
  });

  it('el saldo es un numero y las compras cuentan en silencio', async () => {
    // El saldo se suma; las compras se filtran ("los que no han comprado
    // nunca"). Ni uno de los dos puede llegar como texto.
    const hoja = await recargar(await excelListaProveedores([proveedor()]));

    expect(hoja.getCell('D2').value).toBe(8300);
    // El formato se lee de la CELDA y no de la columna: al recargar, las
    // columnas vuelven numeradas y se pierden las claves.
    expect(hoja.getCell('D2').numFmt).toBe('#,##0.00');
    expect(hoja.getCell('E2').value).toBe(7);
  });

  it('los nulos salen con guion, para que se vea que no hay dato', async () => {
    const hoja = await recargar(
      await excelListaProveedores([proveedor({ contacto: null, telefono: null })]),
    );

    expect(hoja.getCell('B2').value).toBe('—');
    expect(hoja.getCell('C2').value).toBe('—');
  });

  it('el dado de baja sale como "De baja", no como "false"', async () => {
    // La columna se lee en una hoja de calculo: un `false` suelto no le dice
    // nada a quien la tiene delante.
    const hoja = await recargar(await excelListaProveedores([proveedor({ activo: false })]));

    expect(hoja.getCell('F2').value).toBe('De baja');
  });

  it('con la lista vacia solo pone la cabecera', async () => {
    const hoja = await recargar(await excelListaProveedores([]));

    expect(hoja.rowCount).toBe(1);
  });

  describe('el excel se imprime', () => {
    it('centra TODAS las celdas, incluidas las de texto', async () => {
      // Estos archivos se imprimen y se releen en papel, y en papel lo que
      // alinea una tabla son las columnas. Nombre y contacto tambien
      // centrados: dejarlos a la izquierda descuadra la hoja al recortarla.
      const hoja = await recargar(await excelListaProveedores([proveedor()]));

      for (let c = 1; c <= 6; c++) {
        expect(hoja.getRow(1).getCell(c).alignment?.horizontal).toBe('center');
        expect(hoja.getRow(2).getCell(c).alignment?.horizontal).toBe('center');
      }
    });

    it('sale en horizontal y ajustada a una pagina de ancho', async () => {
      // Sin `fitToWidth` el telefono se parte en dos al imprimirse, que es como
      // queda un documento que se archiva.
      const hoja = await recargar(await excelListaProveedores([proveedor()]));

      expect(hoja.pageSetup.orientation).toBe('landscape');
      expect(hoja.pageSetup.fitToPage).toBe(true);
      expect(hoja.pageSetup.fitToWidth).toBe(1);
      expect(hoja.pageSetup.fitToHeight).toBe(0);
    });

    it('repite la cabecera en cada hoja que salga', async () => {
      const hoja = await recargar(await excelListaProveedores([proveedor()]));

      expect(hoja.pageSetup.printTitlesRow).toBe('1:1');
    });
  });
});
