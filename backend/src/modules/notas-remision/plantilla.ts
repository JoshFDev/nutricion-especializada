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

/**
 * Las letras con las que se dibuja el papel.
 *
 * La plantilla esta compuesta con DOS: Bahnschrift Light (312 celdas) y Arial
 * Black (31). pdfkit solo trae las cuatro estandar de PDF, que son mas anchas,
 * y con esas el membrete se encogia a 3.6 puntos por no caber en su celda: un
 * papel correcto en sus medidas y con la letra ilegible no es un papel correcto.
 *
 * Se buscan en dos sitios, en este orden:
 *
 *   1. `plantillas/`, por si alguien deja un `.ttf` de la variante CONDENSADA.
 *      Bahnschrift es de Microsoft y no se versiona aqui (lo mismo que la
 *      plantilla real), asi que ese archivo no se exige, se busca.
 *   2. Las carpetas de fuentes del sistema. En la maquina donde se imprime
 *      esto casi siempre estan, y entonces el papel sale con la letra de
 *      verdad y se ve igual que el Excel.
 *
 * Si no se encuentra ninguna, se dibuja con Helvetica y el papel sigue
 * saliendo: es un cascada a proposito, porque el papel es un documento de
 * negocio y no vale la pena que falte entero por una letra.
 */
const NOMBRES_EN_PLANTILLAS: { patron: RegExp; archivos: string[] }[] = [
  {
    patron: /arial\s*black/i,
    archivos: ['plantillas/papel-negro.ttf', 'plantillas/ArialBlack.ttf'],
  },
  {
    patron: /bahn/i,
    archivos: [
      'plantillas/papel-condensada.ttf',
      'plantillas/papel.ttf',
      'plantillas/BahnschriftCondensed.ttf',
      'plantillas/bahnschrift-condensed.ttf',
    ],
  },
];

/** Que archivos tiene cada fuente en las carpetas del sistema. */
const ARCHIVOS_EN_EL_SISTEMA: { patron: RegExp; archivos: string[] }[] = [
  { patron: /arial\s*black/i, archivos: ['ariblk.ttf', 'Arial_Black.ttf'] },
  { patron: /bahn/i, archivos: ['bahnschrift.ttf', 'Bahnschrift.ttf'] },
];

/** Donde mira el sistema las fuentes. */
const CARPETAS_DE_FUENTES = [
  'C:/Windows/Fonts',
  '/usr/share/fonts',
  '/usr/local/share/fonts',
  '/Library/Fonts',
  '/System/Library/Fonts',
];

/** La ruta de un archivo de fuente, si existe en el primer sitio donde aparezca. */
const buscarFuente = async (archivos: string[]): Promise<string | null> => {
  for (const nombre of archivos) {
    try {
      await readFile(join(RAIZ, nombre));
      return join(RAIZ, nombre);
    } catch (falla) {
      if ((falla as NodeJS.ErrnoException).code !== 'ENOENT') throw falla;
    }
  }
  for (const carpeta of CARPETAS_DE_FUENTES) {
    for (const nombre of archivos) {
      const ruta = `${carpeta}/${nombre}`;
      try {
        await readFile(ruta);
        return ruta;
      } catch (falla) {
        if ((falla as NodeJS.ErrnoException).code !== 'ENOENT') throw falla;
      }
    }
  }
  return null;
};

/**
 * Registra en el documento las letras de la plantilla que encuentre, y devuelve
 * como preguntar por cada celda cual toca.
 *
 * El comparador se construye aqui y no en quien dibuja, por una razon concreta:
 * la lista de patrones se guardaba como TEXTO (`.source`, que es lo que se
 * puede usar de clave en un mapa) y eso tira la bandera `i`. Se acababa buscando
 * "bahn" en "Bahnschrift", sin mayuscula, y ninguna celda encontraba su letra:
 * el papel salia entero con Helvetica sin que nadie se enterara.
 *
 * Por eso se devuelve una FUNCION con los patrones ya cerrados dentro, y quien
 * dibuja solo tiene que preguntar "que letra va en esta celda".
 */
export async function registrarLetrasDelPapel(
  registrar: (nombre: string, ruta: string) => void,
): Promise<(familia: string, negrita: boolean) => string> {
  const encontradas = new Map<RegExp, string>();
  let numero = 0;
  for (const grupo of [...NOMBRES_EN_PLANTILLAS, ...ARCHIVOS_EN_EL_SISTEMA]) {
    if ([...encontradas.keys()].some((ya) => ya.source === grupo.patron.source)) continue;
    const ruta = await buscarFuente(grupo.archivos);
    if (ruta === null) continue;
    numero += 1;
    const nombre = `papel${numero}`;
    try {
      registrar(nombre, ruta);
    } catch {
      // Una fuente que no se puede registrar no es motivo para tirar el papel:
      // esa celda se dibuja con la letra de pdfkit.
      continue;
    }
    encontradas.set(grupo.patron, nombre);
  }

  return (familia: string, negrita: boolean): string => {
    for (const [patron, nombre] of encontradas) {
      if (patron.test(familia)) return nombre;
    }
    return negrita ? 'Helvetica-Bold' : 'Helvetica';
  };
}
