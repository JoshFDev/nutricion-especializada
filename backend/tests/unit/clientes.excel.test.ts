import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { excelListaClientes } from '../../src/modules/clientes/excel.js';
import type { Cliente } from '../../src/modules/clientes/modelo.js';

/**
 * El Excel del listado de clientes.
 *
 * Se prueba el RENDER, no la ruta: `excelListaClientes` es una funcion pura
 * que recibe la lista y devuelve bytes, asi que se comprueba que sale un
 * `.xlsx` de verdad con las columnas de la tabla, sin base de datos ni
 * servidor. Que la ruta lo entregue con el permiso correcto es cosa de
 * `tests/api.test.mjs`.
 *
 * El archivo se RECARGA con ExcelJS, la misma libreria que lo armo: si un
 * libro que exceljs escribe no se puede volver a leer con exceljs, el
 * archivo esta roto.
 */

const cliente = (over: Partial<Cliente> = {}): Cliente => ({
  id: 1,
  codigo_cliente: 'AC01',
  nombre: 'Granja Los Robles',
  establo: 'Establo Norte',
  especie_id: 3,
  especie: 'Bovinos lecheros',
  estatus: 'Activo',
  telefono: '(222) 987 6543',
  direccion: 'Camino a la Sierra s/n',
  rfc: 'ROJG850101HDF3K9',
  razon_social: null,
  saldo_actual: 15400.5,
  creado_en: '2026-09-01T10:00:00.000Z',
  actualizado_en: '2026-09-01T10:00:00.000Z',
  ...over,
});

/** Recarga el buffer como libro de calculo y devuelve la primera hoja. */
const recargar = async (bytes: Buffer): Promise<ExcelJS.Worksheet> => {
  const libro = new ExcelJS.Workbook();
  await libro.xlsx.load(bytes as unknown as ArrayBuffer);
  const hoja = libro.worksheets[0];
  if (hoja === undefined) throw new Error('el libro recargado no trae hoja');
  return hoja;
};

describe('excel de la lista de clientes', () => {
  it('arma un xlsx de verdad', async () => {
    const bytes = await excelListaClientes([cliente()]);
    // Todo .xlsx (un ZIP) empieza con "PK", los bytes de la firma.
    expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK');
  });

  it('pone las cabeceras en el orden de la tabla', async () => {
    const hoja = await recargar(await excelListaClientes([cliente()]));

    const cabeceras = hoja.getRow(1).values as unknown[];
    // `values` empieza en 1: el indice 0 es el de la columna A.
    expect(cabeceras.slice(1)).toEqual([
      'Codigo',
      'Nombre',
      'Especie',
      'RFC',
      'Telefono',
      'Saldo',
      'Estatus',
    ]);
  });

  it('escribe la fila con los datos del cliente', async () => {
    const hoja = await recargar(await excelListaClientes([cliente()]));

    expect(hoja.getCell('A2').value).toBe('AC01');
    expect(hoja.getCell('B2').value).toBe('Granja Los Robles');
    expect(hoja.getCell('C2').value).toBe('Bovinos lecheros');
    expect(hoja.getCell('D2').value).toBe('ROJG850101HDF3K9');
    expect(hoja.getCell('G2').value).toBe('Activo');
  });

  it('el saldo es un numero, no el texto con comas', async () => {
    // Es lo unico de la hoja que alguien va a sumar: escrito como texto,
    // Excel lo ignora en un total y el archivo sirve para poco mas.
    const hoja = await recargar(await excelListaClientes([cliente()]));

    expect(hoja.getCell('F2').value).toBe(15400.5);
    // El formato se lee de la CELDA y no de la columna: al recargar, las
    // columnas vuelven numeradas y se pierden las claves.
    expect(hoja.getCell('F2').numFmt).toBe('#,##0.00');
  });

  it('los nulos salen con guion, para que se vea que no hay dato', async () => {
    const hoja = await recargar(
      await excelListaClientes([
        cliente({ especie: null, rfc: null, telefono: null, codigo_cliente: null }),
      ]),
    );

    expect(hoja.getCell('A2').value).toBe('—');
    expect(hoja.getCell('C2').value).toBe('—');
    expect(hoja.getCell('D2').value).toBe('—');
    expect(hoja.getCell('E2').value).toBe('—');
  });

  it('pone una fila por cliente, en el orden en que llegan', async () => {
    const hoja = await recargar(
      await excelListaClientes([
        cliente({ id: 1, codigo_cliente: 'AC01', nombre: 'Granja Los Robles' }),
        cliente({ id: 2, codigo_cliente: 'AC02', nombre: 'Rancho La Escondida' }),
      ]),
    );

    expect(hoja.getCell('B2').value).toBe('Granja Los Robles');
    expect(hoja.getCell('B3').value).toBe('Rancho La Escondida');
    expect(hoja.rowCount).toBe(3);
  });

  it('con la lista vacia solo pone la cabecera', async () => {
    const hoja = await recargar(await excelListaClientes([]));

    expect(hoja.rowCount).toBe(1);
  });

  describe('el excel se imprime', () => {
    it('centra TODAS las celdas, incluidas las de texto', async () => {
      // Estos archivos se imprimen y se releen en papel, y en papel lo que
      // alinea una tabla son las columnas. Nombre y especie tambien centrados:
      // dejarlos a la izquierda descuadra la hoja al recortarla.
      const hoja = await recargar(await excelListaClientes([cliente()]));

      for (let c = 1; c <= 7; c++) {
        expect(hoja.getRow(1).getCell(c).alignment?.horizontal).toBe('center');
        expect(hoja.getRow(2).getCell(c).alignment?.horizontal).toBe('center');
      }
    });

    it('sale en horizontal y ajustada a una pagina de ancho', async () => {
      // Sin `fitToWidth` el RFC se parte en dos al imprimirse, que es como
      // queda un documento que se archiva.
      const hoja = await recargar(await excelListaClientes([cliente()]));

      expect(hoja.pageSetup.orientation).toBe('landscape');
      expect(hoja.pageSetup.fitToPage).toBe(true);
      expect(hoja.pageSetup.fitToWidth).toBe(1);
      expect(hoja.pageSetup.fitToHeight).toBe(0);
    });

    it('repite la cabecera en cada hoja que salga', async () => {
      // Un listado de doscientas filas sale en cuatro hojas, y sin esto en las
      // tres ultimas no se ve de que columna es cada cosa.
      const hoja = await recargar(await excelListaClientes([cliente()]));

      expect(hoja.pageSetup.printTitlesRow).toBe('1:1');
    });
  });
});
