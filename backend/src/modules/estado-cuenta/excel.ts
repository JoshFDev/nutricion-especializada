import ExcelJS from 'exceljs';
import {
  CELDA_CLIENTE,
  CELDAS_ABONO,
  CELDAS_TOTALES,
  CELDAS_VENTA,
  MAX_MOVIMIENTOS,
  PRIMERA_FILA,
  RANGO_PAPEL,
  ULTIMA_FILA,
  leerPlantilla,
} from './plantilla.js';
import type { HojaCliente } from './modelo.js';

/**
 * La hoja de estado de cuenta en Excel.
 *
 * Es una funcion PURA, igual que `notas-remision/excel.ts`: recibe la cuenta
 * ya armada y devuelve un `Buffer`. No abre la base, no conoce Express y no
 * escribe en disco, asi que se puede probar sin levantar nada (ver
 * `tests/unit/estado-cuenta.excel.test.ts`).
 *
 * La plantilla vive en `backend/plantillas/EstadoCuentaCliente.xlsx`. La real
 * no se versiona (trae los datos del negocio; esta en el `.gitignore`) y el
 * `.example.xlsx` es la misma hoja en blanco, asi que `leerPlantilla` prefiere
 * la real y cae al ejemplo cuando no esta.
 *
 * A diferencia de la nota de remision (que sale protegida), esta hoja NO se
 * protege: el negocio la llena a mano en Excel durante el mes hasta que se
 * acaban los 20 renglones. Una proteccion que impidiera escribir encima
 * estorbaria justo ese uso.
 *
 * Los totales se escriben como FORMULA y no como resultado. Los montos de los
 * renglones van numericos, la formula los suma al abrir el archivo, y asi la
 * hoja siempre dice la suma de lo que muestra y no una cifra que pueda quedar
 * vieja si alguien añade un renglon a mano.
 */

/** Cuantos movimientos se quedaron fuera de las 20 filas del papel. */
export const renglonesFuera = (hoja: HojaCliente): number =>
  Math.max(0, hoja.movimientos.length - MAX_MOVIMIENTOS);

/**
 * El xlsx de estado de cuenta.
 *
 * Rellena los renglones 8-27 en orden cronologico con los ultimos 20
 * movimientos del cliente. Cada renglon es una venta (B fecha, C folio,
 * D monto) o un abono (E fecha, F metodo, G monto), como en el papel.
 */
export async function excelEstadoCuenta(
  cuenta: HojaCliente,
): Promise<{ bytes: Buffer; renglonesFuera: number }> {
  const plantilla = await leerPlantilla();
  const libro = new ExcelJS.Workbook();
  // `load` espera el `Buffer` que el propio exceljs declara (un ArrayBuffer
  // extendido), no el de Node; en runtime son el mismo objeto, asi que el
  // cast es solo para que los dos tipos se encuentren.
  await libro.xlsx.load(plantilla as unknown as ArrayBuffer);
  const hoja = libro.worksheets[0];
  if (hoja === undefined) {
    // La plantilla es una hoja sola, y se cuida con el printArea. Si el
    // archivo se regenera mal, que aparezca aqui, no al imprimir por la noche.
    throw new Error('La plantilla de estado de cuenta no trae ninguna hoja de calculo');
  }

  libro.title = `Estado de cuenta ${cuenta.cliente}`;
  libro.creator = 'Nutricion Especializada';

  // El nombre del cliente, en la celda grande de la plantilla.
  hoja.getCell(CELDA_CLIENTE).value = cuenta.cliente;

  // Los movimientos, del mas antiguo al mas reciente. La hoja solo trae 20
  // filas y los que no cupieron se cuentan en `renglonesFuera` para avisar.
  const visibles = cuenta.movimientos.slice(0, MAX_MOVIMIENTOS);
  for (let i = 0; i < visibles.length; i += 1) {
    const fila = PRIMERA_FILA + i;
    const movimiento = visibles[i];
    // `noUncheckedIndexedAccess` marca el indice como posiblemente indefinido
    // aunque el `for` no lo deje salir del arreglo; el guardia es solo para
    // que el tipo lo sepa.
    if (movimiento === undefined) continue;

    if (movimiento.esAbono) {
      // El abono llena la mitad derecha: fecha, metodo y monto.
      hoja.getCell(`${CELDAS_ABONO.fecha}${fila}`).value = movimiento.fecha;
      hoja.getCell(`${CELDAS_ABONO.metodo}${fila}`).value = movimiento.metodo ?? '';
      const montoAbono = hoja.getCell(`${CELDAS_ABONO.monto}${fila}`);
      montoAbono.value = movimiento.monto;
      montoAbono.numFmt = '#,##0.00';
    } else {
      // La venta llena la mitad izquierda: fecha, folio y monto.
      hoja.getCell(`${CELDAS_VENTA.fecha}${fila}`).value = movimiento.fecha;
      hoja.getCell(`${CELDAS_VENTA.folio}${fila}`).value = movimiento.folio ?? '';
      const montoVenta = hoja.getCell(`${CELDAS_VENTA.monto}${fila}`);
      montoVenta.value = movimiento.monto;
      montoVenta.numFmt = '#,##0.00';
    }
  }

  // Los totales con su formula. Se escriben SIEMPRE (aunque la plantilla ya
  // traiga algunas) para que el resultado no dependa de como venir la hoja.
  const totalVentas = hoja.getCell(CELDAS_TOTALES.ventas);
  totalVentas.value = { formula: `SUM(D${PRIMERA_FILA}:D${ULTIMA_FILA})` };
  totalVentas.numFmt = '#,##0.00';

  const totalAbonos = hoja.getCell(CELDAS_TOTALES.abonos);
  totalAbonos.value = { formula: `SUM(G${PRIMERA_FILA}:G${ULTIMA_FILA})` };
  totalAbonos.numFmt = '#,##0.00';

  const saldo = hoja.getCell(CELDAS_TOTALES.saldo);
  saldo.value = { formula: `${CELDAS_TOTALES.ventas}-${CELDAS_TOTALES.abonos}` };
  saldo.numFmt = '#,##0.00';

  // La leyenda de que es cada total, la misma que la plantilla usa en su
  // segundo bloque (B40 "Ventas", E40 "Saldo"), para que el papel se lea sin
  // volver a la plantilla.
  hoja.getCell(CELDAS_TOTALES.leyendaVentas).value = 'Ventas';
  hoja.getCell(CELDAS_TOTALES.leyendaSaldo).value = 'Saldo';

  // Lo que se imprime: la cabecera, los 20 renglones y la fila del saldo.
  // La plantilla no trae bien puesto el area de impresion y quien imprimiera
  // se llevaria el segundo bloque vacio de la plantilla en el papel.
  hoja.pageSetup.printArea = RANGO_PAPEL;
  hoja.pageSetup.fitToPage = true;
  hoja.pageSetup.fitToWidth = 1;
  hoja.pageSetup.fitToHeight = 1;

  // `writeBuffer` escribe el ZIP en memoria y el `Buffer` que devuelve es
  // el propio de exceljs; `Buffer.from` lo pasa a un Buffer de Node, que es
  // el que espera la firma de la funcion y el que `send` sabe mandar.
  const bytes = Buffer.from(await libro.xlsx.writeBuffer());
  return { bytes, renglonesFuera: renglonesFuera(cuenta) };
}
