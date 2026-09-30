import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * La plantilla del papel de la nota de remision.
 *
 * Vive aqui, y no dentro de `excel.ts`, porque LA USAN LOS DOS: el Excel la
 * rellena con `exceljs` y el PDF la dibuja con `pdfkit`. Es la misma forma en
 * los dos formatos y, sobre todo, es el mismo archivo: si alguien corrige una
 * linea de la plantilla, el Excel y el PDF quedan igual de corregidos, porque
 * los dos leen esto y no una copia de las medidas metidas a mano.
 *
 * Por eso el PDF no trae medidas propias de filas ni de columnas: las pide a la
 * plantilla. Un PDF con numeros sueltos se desincroniza de la plantilla en la
 * primera fila que alguien ajuste, y el papel impreso deja de coincidir con el
 * Excel justo cuando alguien lo nota.
 *
 * La plantilla real no se versiona (trae la caratula con los datos del
 * negocio), asi que en un clon limpio solo existe el `.example.xlsx`, que es la
 * misma hoja con la caratula en blanco.
 */

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const RUTA_PLANTILLA = join(RAIZ, 'plantillas', 'nota-remision.xlsx');
const RUTA_PLANTILLA_EJEMPLO = join(RAIZ, 'plantillas', 'nota-remision.example.xlsx');

/**
 * La plantilla real y, si no esta, el ejemplo.
 *
 * Un error que no sea "no existe" si se propaga: un archivo corrupto o sin
 * permiso tiene que doler, no esconderse detras del ejemplo.
 */
export async function leerPlantilla(): Promise<Buffer> {
  try {
    return await readFile(RUTA_PLANTILLA);
  } catch (falla) {
    if ((falla as NodeJS.ErrnoException).code !== 'ENOENT') throw falla;
    return readFile(RUTA_PLANTILLA_EJEMPLO);
  }
}

/** Los renglones de detalle de la plantilla empiezan en la fila 13, de 3 en 3. */
export const PRIMERA_FILA_DETALLE = 13;
export const FILAS_POR_RENGLON = 3;
export const MAX_RENGLONES = 9;

/**
 * Los 5 bloques combinados de cada renglon, con su celda principal.
 *
 * La plantilla no tiene una columna "producto": el nombre ocupa DOS columnas
 * (B:C) porque los nombres largos no caben en una, y el subtotal tambien
 * (F:G). Las medidas estan en la plantilla; esto es solo el mapa de donde va
 * cada dato, y es el mismo que usa `excel.ts`.
 */
export const BLOQUES_DETALLE = [
  { celda: 'A' },
  { celda: 'B' },
  { celda: 'D' },
  { celda: 'E' },
  { celda: 'F' },
] as const;

/** Cuantas filas tiene el papel, de la 1 a esta. */
export const FILAS_PAPEL = 49;

/** Cuantas columnas tiene el papel. */
export const COLUMNAS_PAPEL = ['A', 'B', 'C', 'D', 'E', 'F', 'G'] as const;

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
] as const;

/**
 * La fecha como se lee en el papel: "27-sep-26".
 *
 * `nota.fecha` llega como "AAAA-MM-DD" (el formato de la base), y en el papel
 * va en el mismo orden coloquial que en el Excel. El mes es la abreviatura en
 * espanol, como la escribe la gente, no un numero ni la inicial mayuscula.
 */
export function fechaCorta(fecha: string): string {
  const [anio, mes, dia] = fecha.split('-').map(Number) as [number, number, number];
  const mesCorto = MESES_CORTOS[mes - 1];
  if (mesCorto === undefined) return fecha;
  const diaTexto = String(dia).padStart(2, '0');
  const anioTexto = String(anio).slice(2);
  return `${diaTexto}-${mesCorto}-${anioTexto}`;
}
