import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { kilosComoTexto, montoComoTexto, numeroComoTexto } from '../../core/valores.js';
import type { ClienteImprimible, Nota } from './modelo.js';

/**
 * La nota de remision en Excel.
 *
 * Es una funcion PURA, como `pdf.ts`: recibe la nota ya leida y devuelve un
 * `Buffer` de bytes. No abre la base, no conoce Express y no escribe en
 * disco, asi que se puede probar sin levantar nada (ver
 * `tests/unit/notas.excel.test.ts`).
 *
 * La plantilla vive en `backend/plantillas/nota-remision.xlsx`, y esa NO se
 * versiona: trae la direccion y el telefono del negocio, que no tienen por
 * que estar en un repositorio. Lo que si se versiona es
 * `nota-remision.example.xlsx`, la misma hoja con la caratula en blanco, que
 * es la que usan un clon limpio y las pruebas. `leerPlantilla` prefiere la
 * real y cae al ejemplo cuando no esta.
 *
 * El `.xlsx` no puede vivir dentro de `src/`: `tsc` emite `.js` y nada mas,
 * asi que existiria en desarrollo y desapareceria en `dist/`, y el fallo
 * apareceria solo en produccion. La ruta se calcula desde la posicion de ESTE
 * archivo y no desde `process.cwd()`, por el mismo motivo que
 * `scripts/migrar.ts`: si el servidor se lanza desde otra carpeta, `cwd` no
 * apunta a `backend/`.
 *
 * Los datos que se imprimen son los de la base, nunca un recalculo. El
 * total es el `subtotal` de `notas_remision` y los precios los del renglon,
 * y por eso la celda E40 se llena con `nota.subtotal` en vez de sumar la
 * hoja: si aqui se recalculara y los dos no coincidieran, el Excel estaria
 * mostrando una cifra que el sistema no reconoce.
 *
 * La hoja sale PROTEGIDA (`ws.protect`): el archivo termina en manos de
 * quien recibe la mercancia, y la proteccion hace que no se pueda cambiar
 * un renglon por error desde Excel. No es seguridad de verdad (quien sepa
 * de Excel la quita en diez segundos), es evitar que el papel se edite sin
 * querer; la diagonal en los renglones vacios es lo que deja claro que la
 * nota viene completa o no se vuelve a escribir.
 */

/** Los renglones de detalle de la plantilla empiezan en la fila 13, de 3 en 3. */
const PRIMERA_FILA_DETALLE = 13;
const FILAS_POR_RENGLON = 3;
const MAX_RENGLONES = 9;

/** Los __5__ bloques combinados de cada renglon, con su celda principal. */
const BLOQUES_DETALLE = [
  { celda: 'A' },
  { celda: 'B' },
  { celda: 'D' },
  { celda: 'E' },
  { celda: 'F' },
] as const;

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const RUTA_PLANTILLA = join(RAIZ, 'plantillas', 'nota-remision.xlsx');
const RUTA_PLANTILLA_EJEMPLO = join(RAIZ, 'plantillas', 'nota-remision.example.xlsx');

/**
 * La plantilla real y, si no esta, el ejemplo.
 *
 * La real no se versiona (trae la caratula con los datos del negocio), asi que
 * en un clon limpio solo existe el ejemplo, con la caratula en blanco. Un
 * error que no sea "no existe" si se propaga: un archivo corrupto o sin
 * permiso tiene que doler, no esconderse detras del ejemplo.
 */
async function leerPlantilla(): Promise<Buffer> {
  try {
    return await readFile(RUTA_PLANTILLA);
  } catch (falla) {
    if ((falla as NodeJS.ErrnoException).code !== 'ENOENT') throw falla;
    return readFile(RUTA_PLANTILLA_EJEMPLO);
  }
}

/**
 * La fecha como se lee en el papel: "27-sep-26".
 *
 * `nota.fecha` llega como "AAAA-MM-DD" (el formato de la base), y en el
 * papel va en el mismo orden coloquial que en el PDF. El mes es la
 * abreviatura en espanol, como la escribe la gente, no un numero ni la
 * inicial mayuscula.
 */
const MESES_CORTOS = [
  'ene',
  'feb',
  'mar',
  'abr',
  'may',
  'jun',
  'jul',
  'ago',
  'sep',
  'oct',
  'nov',
  'dic',
];

const fechaCorta = (fecha: string): string => {
  const [anio, mes, dia] = fecha.split('-').map(Number) as [number, number, number];
  const mesCorto = MESES_CORTOS[mes - 1];
  if (mesCorto === undefined) return fecha;
  const diaTexto = String(dia).padStart(2, '0');
  const anioTexto = String(anio).slice(2);
  return `${diaTexto}-${mesCorto}-${anioTexto}`;
};

/**
 * La diagonal que tacha los renglones vacios.
 *
 * En la plantilla cada renglon de detalle son 5 bloques combinados en
 * vertical (A, B:C, D, E, F:G). El borde diagonal se pone en LA CELDA
 * PRINCIPAL de cada bloque (la de arriba), y la diagonal se dibuja a lo
 * largo de todo el rango combinado: es como lo dibuja Excel cuando se le
 * pone un borde a una celda combinada.
 */
const tacharRenglon = (hoja: ExcelJS.Worksheet, fila: number): void => {
  for (const bloque of BLOQUES_DETALLE) {
    const celda = hoja.getCell(`${bloque.celda}${fila}`);
    celda.border = {
      ...celda.border,
      diagonal: { up: true, down: true, style: 'thin', color: { argb: 'FF000000' } },
    };
  }
};

/** Escribe en la celda principal del bloque combinado, no en el rango. */
const poner = (hoja: ExcelJS.Worksheet, celda: string, valor: string): void => {
  hoja.getCell(celda).value = valor;
};

/** Cuantos renglones quedan fuera porque la plantilla solo trae 9 bloques. */
export const renglonesFuera = (nota: Nota): number =>
  Math.max(0, nota.renglones.length - MAX_RENGLONES);

/**
 * El Excel de una nota.
 *
 * Devuelve ademas cuantos renglones se quedaron fuera y no caben en el
 * papel: la plantilla tiene 9 bloques de detalle fijos, y quien imprime
 * tiene que saber que el documento no lleva todo antes de entregarlo.
 */
export async function excelNotaRemision(
  nota: Nota,
  cliente: ClienteImprimible,
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
    // archivo se regenera mal, que aparezca aqui, no al imprimir por la
    // noche.
    throw new Error('La plantilla de nota de remision no trae ninguna hoja de calculo');
  }

  libro.title = `Nota de remision ${nota.folio}`;
  libro.creator = cliente.nombre;

  // Cabecera: folio, cliente, fecha y destino de entrega. Cada valor va en
  // la celda principal de su bloque combinado (B7, B8, E8, B10).
  poner(hoja, 'B7', nota.folio);
  poner(hoja, 'B8', cliente.nombre);
  poner(hoja, 'E8', fechaCorta(nota.fecha));
  // El destino es el de la nota, y si la nota no trae direccion de entrega
  // (el producto se quedo en el almacen), el de la ficha del cliente. Igual
  // que el PDF (`pdf.ts`), no se inventa una direccion que no se mando.
  poner(hoja, 'B10', nota.direccion_entrega ?? cliente.direccion ?? '');

  // Detalle: 9 bloques fijos. Los que la nota no llena se tachan con la
  // diagonal, para que despues de impresa nadie escriba productos.
  for (let i = 0; i < MAX_RENGLONES; i += 1) {
    const fila = PRIMERA_FILA_DETALLE + i * FILAS_POR_RENGLON;
    const renglon = nota.renglones[i];

    if (renglon === undefined) {
      tacharRenglon(hoja, fila);
      continue;
    }

    poner(hoja, `A${fila}`, numeroComoTexto(renglon.cantidad_bultos, 2));
    poner(hoja, `B${fila}`, renglon.producto_nombre);
    poner(hoja, `D${fila}`, kilosComoTexto(renglon.kg_bulto));
    poner(hoja, `E${fila}`, montoComoTexto(renglon.precio_unit_kg));
    poner(hoja, `F${fila}`, montoComoTexto(renglon.subtotal));
  }

  // El total de la nota, el de la base, no el de sumar la hoja.
  poner(hoja, 'E40', montoComoTexto(nota.subtotal));

  // `protect` bloquea la edicion de las celdas bloqueadas (todas las de la
  // plantilla) dejando libre solo la seleccion: se puede marcar un renglon
  // para copiarlo, no para cambiarlo. Importante especialmente en la fecha
  // y en los renglones: a quien recibe la mercancia le llega un papel que
  // no se puede alterar por error.
  await hoja.protect('remision', { selectLockedCells: true, selectUnlockedCells: true });

  // `writeBuffer` escribe el ZIP en memoria y el `Buffer` que devuelve es
  // el propio de exceljs; `Buffer.from` lo pasa a un Buffer de Node, que es
  // el que espera la firma de la funcion y el que `send` sabe mandar.
  const bytes = Buffer.from(await libro.xlsx.writeBuffer());
  return { bytes, renglonesFuera: renglonesFuera(nota) };
}
