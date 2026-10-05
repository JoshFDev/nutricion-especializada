import ExcelJS from 'exceljs';
import type { Cliente } from './modelo.js';

/**
 * El Excel del LISTADO de clientes.
 *
 * Las columnas son las de la tabla de `/clientes`, en el mismo orden y con
 * los mismos nombres: Codigo, Nombre, Especie, RFC, Telefono, Saldo y
 * Estatus. El RFC entra aunque no se pueda editar por esta API (vive en
 * `datos_fiscales_cliente`), porque es lo que hace falta para facturar y
 * quien se lleva el archivo lo tiene delante al exportarlo.
 *
 * El saldo va como NUMERO con formato de dos decimales, no como el texto de
 * `montoComoTexto`: en una hoja de calculo la columna se suma, y un saldo
 * escrito como `"1,500.00"` es texto que Excel no suma. El formato hace el
 * papel de las comas, que para eso esta `numFmt`.
 *
 * TODO CENTRADO, como el Excel de productos, porque estos archivos se
 * IMPRIMEN: van a la cuenta corriente y se releen en papel, y ahi una columna
 * de numeros pegada al borde derecho no cuadra con la de al lado. Nombre y
 * especie tambien centrados: en pantalla una columna de texto se lee mejor a
 * la izquierda, pero en una hoja impresa manda que las columnas no queden
 * descolgadas unas de otras al recortarse.
 *
 * De la impression se encarga `pageSetup` al final: horizontal, ajustada a una
 * pagina de ancho —que si no, el RFC se parte en dos al imprimirse— y con la
 * cabecera repetida en cada hoja, porque un listado de doscientas filas sale
 * en cuatro y en las tres ultimas no se ve de que columna es cada cosa.
 */
export async function excelListaClientes(clientes: Cliente[]): Promise<Buffer> {
  const libro = new ExcelJS.Workbook();
  const hoja = libro.addWorksheet('Clientes');

  libro.title = 'Listado de clientes';
  libro.creator = 'Nutricion Especializada';

  hoja.columns = [
    { header: 'Codigo', key: 'codigo_cliente', width: 16 },
    { header: 'Nombre', key: 'nombre', width: 40 },
    { header: 'Especie', key: 'especie', width: 24 },
    { header: 'RFC', key: 'rfc', width: 18 },
    { header: 'Telefono', key: 'telefono', width: 18 },
    { header: 'Saldo', key: 'saldo_actual', width: 14 },
    { header: 'Estatus', key: 'estatus', width: 12 },
  ];

  const columnas = hoja.columns.length;

  // Todas las columnas centradas, como en productos: el archivo se imprime y
  // en papel lo que alinea es que las columnas cuadren entre si.
  for (const col of hoja.columns) {
    if (col.key) hoja.getColumn(col.key).alignment = CENTRADO;
  }

  // Cabecera: azul corporativo, blanco, centrado y con bordes. Solo la fila 1.
  for (let c = 1; c <= columnas; c++) {
    hoja.getRow(1).getCell(c).style = {
      font: { bold: true, color: { argb: 'FFFFFFFF' } },
      fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A8A' } },
      alignment: CENTRADO,
      border: {
        top: { style: 'thin', color: { argb: 'FF000000' } },
        bottom: { style: 'thin', color: { argb: 'FF000000' } },
        left: { style: 'thin', color: { argb: 'FF000000' } },
        right: { style: 'thin', color: { argb: 'FF000000' } },
      },
    };
  }

  for (const cliente of clientes) {
    const fila = hoja.addRow({
      codigo_cliente: cliente.codigo_cliente ?? '—',
      nombre: cliente.nombre,
      especie: cliente.especie ?? '—',
      rfc: cliente.rfc ?? '—',
      telefono: cliente.telefono ?? '—',
      saldo_actual: cliente.saldo_actual,
      estatus: cliente.estatus,
    });
    for (let c = 1; c <= columnas; c++) {
      fila.getCell(c).style = {
        alignment: CENTRADO,
        border: { bottom: { style: 'thin', color: { argb: 'FFD0D0D0' } } },
      };
    }
  }

  hoja.getColumn('saldo_actual').numFmt = '#,##0.00';

  // Anchos: el que trae la columna como minimo, y lo que ocupe el contenido
  // como maximo, con 50 de tope para que un nombre de 200 caracteres no
  // agrande la hoja hasta que el resto de las columnas salgan del papel.
  for (const col of hoja.columns) {
    if (!col.key) continue;
    const columna = hoja.getColumn(col.key);
    const base = col.width ?? 10;
    let maximo = base;
    columna.eachCell({ includeEmpty: false }, (celda) => {
      const largo = (typeof celda.value === 'string' ? celda.value : '').length + 2;
      if (largo > maximo) maximo = largo;
    });
    columna.width = Math.min(maximo, 50);
  }

  hoja.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: columnas },
  };
  hoja.views = [{ state: 'frozen', ySplit: 1 }];

  // Impresion: horizontal y ajustada a una pagina de ANCHO, con la cabecera
  // repetida en cada hoja. `fitToHeight: 0` deja que el listado crezca hacia
  // abajo las paginas que necesite, en vez de apretarlo todo en una sola.
  hoja.pageSetup = {
    orientation: 'landscape',
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.3, footer: 0.3 },
    printTitlesRow: '1:1',
  };

  return Buffer.from(await libro.xlsx.writeBuffer());
}

/** El centrado que comparten cabecera y datos. */
const CENTRADO: Partial<ExcelJS.Alignment> = { horizontal: 'center', vertical: 'middle' };
