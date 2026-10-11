import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * La plantilla del estado de cuenta del cliente.
 *
 * Vive aqui y no dentro de `excel.ts` porque es lo que la hoja lee y, si algun
 * dia el PDF la dibuja tambien, los dos la toman de este mismo sitio y no de
 * medidas metidas a mano (es el mismo criterio que `notas-remision/plantilla.ts`).
 *
 * La plantilla real no se versiona (es la hoja del negocio; ver `.gitignore`),
 * asi que en un clon limpio solo existe el `.example.xlsx`, que es la misma
 * hoja en blanco. `leerPlantilla` prefiere la real y cae al ejemplo.
 */

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const RUTA_PLANTILLA = join(RAIZ, 'plantillas', 'EstadoCuentaCliente.xlsx');
const RUTA_PLANTILLA_EJEMPLO = join(RAIZ, 'plantillas', 'EstadoCuentaCliente.example.xlsx');

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

/** La hoja trae 20 renglones de datos, de la fila 8 a la 27. */
export const PRIMERA_FILA = 8;
export const ULTIMA_FILA = 27;
export const MAX_MOVIMIENTOS = ULTIMA_FILA - PRIMERA_FILA + 1;

/**
 * Las celdas de cada movimiento.
 *
 * Cada renglon de la hoja es una venta O un abono, y por eso hay dos mapas:
 * la venta llena B (fecha), C (folio) y D (monto); el abono llena E (fecha),
 * F (metodo) y G (monto). Un renglon nunca llena las dos mitades.
 */
export const CELDAS_VENTA = { fecha: 'B', folio: 'C', monto: 'D' } as const;
export const CELDAS_ABONO = { fecha: 'E', metodo: 'F', monto: 'G' } as const;

/** El nombre del cliente va en C4, con la fuente grande de la plantilla. */
export const CELDA_CLIENTE = 'C4';

/** Los totales y el saldo. El `C`/`F` son las etiquetas y el resto, valores. */
export const CELDAS_TOTALES = {
  etiquetaVentas: 'C28',
  ventas: 'D28',
  etiquetaAbonos: 'F28',
  abonos: 'G28',
  saldo: 'G29',
  leyendaVentas: 'B29',
  leyendaSaldo: 'E29',
} as const;

/** Lo que se imprime: la cabecera, los 20 renglones y la fila del saldo. */
export const RANGO_PAPEL = 'B2:G29';

/**
 * La fecha como la pide el usuario: "dia-mes-anio" en numeros.
 *
 * Llega "AAAA-MM-DD" del SQL (el `fecha::TEXT`) y en la hoja va en el mismo
 * orden coloquial que en el abono y en la venta: "27-09-2026".
 */
export function fechaDiaMesAnio(fecha: string): string {
  const [anio, mes, dia] = fecha.split('-');
  if (anio === undefined || mes === undefined || dia === undefined) return fecha;
  return `${dia}-${mes}-${anio}`;
}
