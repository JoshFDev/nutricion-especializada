import PDFDocument from 'pdfkit';
import ExcelJS from 'exceljs';
import { kilosComoTexto, montoComoTexto, numeroComoTexto } from '../../core/valores.js';
import {
  COLUMNAS_PAPEL,
  FILAS_PAPEL,
  FILAS_POR_RENGLON,
  MAX_RENGLONES,
  PRIMERA_FILA_DETALLE,
  fechaCorta,
  leerPlantilla,
} from './plantilla.js';
import type { ClienteImprimible, Nota } from './modelo.js';

/**
 * La nota de remision impresa: LA PLANTILLA DEL EXCEL, TAL CUAL.
 *
 * Este archivo dibuja la misma hoja que `excel.ts` rellena, no una maqueta
 * parecida. Las dos salen de `plantillas/nota-remision.xlsx` y las dos leen su
 * geometria de ahi: los anchos de columna, las alturas de fila, las celdas
 * combinadas, los textos fijos y el tamano de cada letra. Por eso el PDF y el
 * Excel son el mismo papel y no dos papeles parecidos, y por eso, si alguien
 * corrige una linea de la plantilla, los dos quedan corregidos.
 *
 * Que salga IGUAL, y no "parecido", es lo que hace util tener los dos: en un
 * mostrador da lo mismo imprima quien lo imprima, y la copia del cliente y la
 * del archivo son el mismo documento con el mismo numero.
 *
 * Como se arma:
 *
 *   1. Se mide la plantilla: de donde empieza cada columna y cada fila, y que
 *      celdas hay. No hay NI UN numero de medida metido a mano en este archivo.
 *   2. Se escriben los DATOS en las mismas celdas donde los pone el Excel (B7 el
 *      folio, B8 el cliente, E8 la fecha, B10 la direccion, los renglones en
 *      cada bloque y E40 el total), ANTES de dibujar.
 *   3. Se dibuja una caja por celda y su texto con la misma letra y el mismo
 *      lado, y encima la diagonal de los bloques que la nota no llena, igual que
 *      el Excel.
 *
 * La plantilla es mas ALTA que una hoja LETTER (828 contra 792 puntos), que es
 * justo por lo que el Excel la imprime con "ajustar a una pagina". Aqui se hace
 * la misma cuenta, asi que el PDF sale en una hoja y del mismo tamano que el
 * Excel.
 *
 * Por que se arma ENTERO en memoria y no se hace `doc.pipe(res)`: `pipe` manda
 * las cabeceras antes de saber si el documento se pudo dibujar, y a partir de
 * ahi un error ya no se puede convertir en un 404 ni en un 500 con su mensaje:
 * el manejador de errores intentaria poner un JSON encima de una respuesta que
 * ya empezo a salir como PDF. Armando el buffer primero, un fallo es un fallo de
 * verdad y el cliente recibe el mismo JSON que en cualquier otra ruta.
 *
 * Lo que se imprime es lo que la base guardo, nunca un recalculo. El importe
 * que vale es el `subtotal` de `notas_remision`, que mantiene
 * `fn_recalcular_subtotal_nota`, y los precios son los del renglon, que son los
 * que se cobraron aunque hoy la lista diga otra cosa.
 */

/** Membrete: sale impreso arriba. Viene del entorno, no de la base. */
export interface DatosEmpresa {
  nombre: string;
  rfc: string;
  direccion: string;
  telefono: string;
}

/**
 * La hoja y los margenes con los que la imprime Excel.
 *
 * Los margenes son los del `pageSetup` de la plantilla, en puntos (1 pulgada =
 * 72). No son los de pdfkit: si se dibujara con otros, el papel saldria
 * distinto al del Excel y habria que volver a ajustarlos cada vez que cambie el
 * tamano.
 */
const PAGINA = { ancho: 612, alto: 792 } as const;
const MARGEN = { arriba: 53.8, abajo: 0, izquierda: 28.3, derecha: 28.3 } as const;

/** El hueco entre el borde de la celda y su texto. */
const RELLENO = 2;

const GRIS_LINEA = '#000000';
const GRIS_SUAVE = '#9aa0a6';
const ROJO = '#b00020';

/**
 * A ExcelJS le faltan los tipos de `load`, aunque el paquete si lo trae. Sin el
 * cast, `tsc` dice que el metodo no existe y en runtime si esta.
 */
interface ExcelJSConLoad {
  load: (datos: ArrayBuffer) => Promise<unknown>;
}

/** Una celda ya resuelta: donde esta, que ocupa y que dice. */
interface Casilla {
  /** La celda principal del bloque combinado; para una celda suelta, ella misma. */
  maestro: string;
  x: number;
  y: number;
  ancho: number;
  alto: number;
  texto: string;
  tamano: number;
  negrita: boolean;
  rojo: boolean;
  alineacion: 'left' | 'center' | 'right';
  centroVertical: boolean;
}

/** La plantilla, ya medida. */
interface Papel {
  casillas: Casilla[];
  ancho: number;
  alto: number;
}

/** Que dice el estilo de una celda, sea texto plano, formula o texto con formato. */
const textoDe = (valor: unknown): string => {
  if (valor === null || valor === undefined) return '';
  if (typeof valor === 'string' || typeof valor === 'number') return String(valor);
  if (typeof valor === 'object') {
    const objeto = valor as { result?: unknown; richText?: { text: string }[]; text?: unknown };
    if (Array.isArray(objeto.richText)) return objeto.richText.map((parte) => parte.text).join('');
    if (objeto.result !== undefined) return textoDe(objeto.result);
    if (objeto.text !== undefined) return textoDe(objeto.text);
  }
  return '';
};

/**
 * Lee la plantilla y la mide.
 *
 * De aqui salen TODOS los numeros del papel: donde empieza cada columna, donde
 * cada fila, y el tamano de cada caja. La conversion de columna a puntos es la
 * de Excel (px = ancho * 7 + 5, y pt = px * 0.75 a 96 dpi); con estos numeros el
 * papel queda del mismo tamano que en Excel, que es lo que importa. Si se
 * cambian, el PDF se descuadra del Excel sin que nada avise.
 */
const medirPlantilla = async (): Promise<Papel> => {
  const libro = new ExcelJS.Workbook();
  // `load` cuelga de `libro.xlsx`, igual que en `excel.ts`. El buffer es el
  // `ArrayBuffer` que declara exceljs, no el `Buffer` de Node: en runtime son
  // el mismo objeto y el cast es solo para que los dos tipos se encuentren.
  await (libro.xlsx as unknown as ExcelJSConLoad).load(
    (await leerPlantilla()) as unknown as ArrayBuffer,
  );
  const hoja = libro.worksheets[0];
  if (hoja === undefined) {
    // La plantilla es una hoja sola. Si el archivo se regenera mal, que aparezca
    // aqui y no al imprimir por la noche.
    throw new Error('La plantilla de nota de remision no trae ninguna hoja de calculo');
  }

  // Donde ACABA cada columna y cada fila. Con esos dos numeros, el ancho de
  // cualquier celda es restar, y el de un bloque combinado sale solo.
  const finDeColumna: number[] = [];
  let x = 0;
  for (let c = 1; c <= COLUMNAS_PAPEL.length; c += 1) {
    x += ((hoja.getColumn(c).width ?? 8.43) * 7 + 5) * 0.75;
    finDeColumna.push(x);
  }
  const ancho = x;

  const finDeFila: number[] = [];
  let y = 0;
  for (let f = 1; f <= FILAS_PAPEL; f += 1) {
    y += hoja.getRow(f).height ?? 15;
    finDeFila.push(y);
  }
  const alto = y;

  const casillas: Casilla[] = [];
  const vistas = new Set<string>();
  for (let f = 1; f <= FILAS_PAPEL; f += 1) {
    for (let c = 1; c <= COLUMNAS_PAPEL.length; c += 1) {
      const celda = hoja.getCell(f, c);
      // El maestro de una celda combinada trae el rango entero; de ahi salen las
      // medidas de la caja. Una celda suelta es un rango de una.
      const maestro = celda.master;
      const clave = maestro.address;
      if (vistas.has(clave)) continue;
      vistas.add(clave);

      // El rango combinado, si lo hay; una celda suelta no tiene.
      const rango = maestro.address.includes(':') ? maestro.address.split(':') : [];
      const finDe = rango[1] ?? '';
      const filaFin = /\d+/.exec(finDe);
      const colFin = /[A-Z]+/.exec(finDe);
      const ultimaFila = filaFin === null ? undefined : hoja.getRow(Number(filaFin[0]));
      const ultimaCol = colFin === null ? undefined : hoja.getColumn(colFin[0]);

      const x0 = c === 1 ? 0 : (finDeColumna[c - 2] ?? 0);
      const y0 = f === 1 ? 0 : (finDeFila[f - 2] ?? 0);
      // `ultimaCol.number` ya es el numero de columna (1 a 7), que es
      // justo el indice de `finDeColumna` menos uno.
      const x1 =
        ultimaCol !== undefined
          ? (finDeColumna[ultimaCol.number - 1] ?? x)
          : (finDeColumna[c - 1] ?? x);
      const y1 =
        ultimaFila !== undefined
          ? (finDeFila[ultimaFila.number - 1] ?? y)
          : (finDeFila[f - 1] ?? y);

      const fuente = celda.font ?? {};
      const alineacion = celda.alignment ?? {};
      const horizontal = alineacion.horizontal;

      casillas.push({
        maestro: clave,
        x: x0,
        y: y0,
        ancho: x1 - x0,
        alto: y1 - y0,
        texto: textoDe(celda.value),
        tamano: typeof fuente.size === 'number' ? fuente.size : 12,
        negrita: fuente.bold === true,
        rojo: fuente.color?.argb === 'FFFF0000' || fuente.color?.argb === 'FFB00020',
        alineacion: horizontal === 'center' || horizontal === 'right' ? horizontal : 'left',
        centroVertical: alineacion.vertical === 'middle' || alineacion.vertical === 'bottom',
      });
    }
  }

  return { casillas, ancho, alto };
};

/**
 * El hueco que se deja abajo, para que la ultima fila no quede pegada al borde
 * de papel. Sin esto el papel entra justo hasta el limite y pdfkit, que anade
 * pagina cuando un texto se pasa del margen inferior, reparte el formulario en
 * tres hojas.
 */
const RESERVA = 10;

/** La escala con la que el papel entra en la hoja: la misma cuenta que Excel. */
const escalaDelPapel = (papel: Papel): number => {
  const utilAncho = PAGINA.ancho - MARGEN.izquierda - MARGEN.derecha;
  const utilAlto = PAGINA.alto - MARGEN.arriba - RESERVA;
  return Math.min(1, utilAncho / papel.ancho, utilAlto / papel.alto);
};

/**
 * Un texto que la letra estandar no sabe dibujar.
 *
 * Las fuentes de pdfkit (Helvetica) usan WinAnsi, que ya trae las tildes y la
 * enye del espanol, asi que los acentos se dejan pasar tal cual. Lo que se
 * cambia por '?' es lo que no cabe en 255: un emoji o un ideograma, que en el
 * papel salen como un signo de pregunta en vez de romper el PDF entero.
 */
const textoSeguro = (texto: string): string =>
  [...texto].map((caracter) => ((caracter.codePointAt(0) ?? 63) <= 0xff ? caracter : '?')).join('');

const aBuffer = (doc: PDFKit.PDFDocument): Promise<Buffer> =>
  new Promise((resolver, rechazar) => {
    const trozos: Buffer[] = [];
    doc.on('data', (trozo: Buffer) => {
      trozos.push(trozo);
    });
    doc.on('end', () => {
      resolver(Buffer.concat(trozos));
    });
    doc.on('error', rechazar);
    doc.end();
  });

/** El recuadro de una celda. */
const recuadro = (
  doc: PDFKit.PDFDocument,
  caja: { x: number; y: number; ancho: number; alto: number },
): void => {
  doc
    .save()
    .lineWidth(0.6)
    .strokeColor(GRIS_LINEA)
    .rect(caja.x, caja.y, caja.ancho, caja.alto)
    .stroke()
    .restore();
};

/**
 * El texto de una celda, con la misma letra y el mismo lado que en el Excel.
 *
 * Hay una diferencia que obliga a ajustar: la plantilla esta compuesta con
 * Bahnschrift Condensed, que es una letra ESTRECHA, y pdfkit solo trae
 * Helvetica, que es mas ancha. Con la misma medida, "SUBTOTAL" se pasaba de su
 * celda y pdfkit lo partia en dos ("SUBT" + "AL"), y un nombre de producto
 * partido a media palabra en el papel es peor que uno un punto mas chico.
 *
 * Por eso, cuando el texto no cabe en su caja, se baja la letra lo justo para
 * que quepa. Solo baja en esas celdas: el resto va con el tamano que dice la
 * plantilla, que es el que se ve bien.
 *
 * La vertical se centra con el alto de la LINEA, no con el de la caja: casi
 * todas las celdas de la plantilla son de altura triple y su texto va al medio,
 * que es lo que dice `vertical: middle`.
 */
const textoDeCelda = (doc: PDFKit.PDFDocument, caja: Casilla): void => {
  if (caja.texto === '') return;
  doc.font(caja.negrita ? 'Helvetica-Bold' : 'Helvetica').fillColor(caja.rojo ? ROJO : '#000000');

  const texto = textoSeguro(caja.texto);
  const disponible = caja.ancho - RELLENO * 2;
  const anchoNecesario = doc.fontSize(caja.tamano).widthOfString(texto);
  const tamano =
    anchoNecesario > disponible ? (caja.tamano * disponible) / anchoNecesario : caja.tamano;
  doc.fontSize(tamano);

  const altoLinea = doc.currentLineHeight();
  const y = caja.centroVertical ? caja.y + (caja.alto - altoLinea) / 2 : caja.y + RELLENO;
  doc.text(texto, caja.x + RELLENO, y, {
    width: disponible,
    align: caja.alineacion,
    lineBreak: false,
  });
};

/** Escribe un dato en una celda de la plantilla. */
const escribir = (papel: Papel, maestro: string, texto: string): void => {
  const casilla = papel.casillas.find((c) => c.maestro === maestro);
  if (casilla === undefined) return;
  casilla.texto = texto;
};

/**
 * La diagonal que tacha un bloque de renglon vacio.
 *
 * Es la misma que el Excel pone en los bloques sin usar: de esquina a esquina,
 * para que se vea que la nota viene completa y no se escriba nada despues.
 */
const tachar = (doc: PDFKit.PDFDocument, caja: Casilla): void => {
  doc
    .save()
    .lineWidth(0.5)
    .strokeColor(GRIS_SUAVE)
    .moveTo(caja.x + 1, caja.y + 1)
    .lineTo(caja.x + caja.ancho - 1, caja.y + caja.alto - 1)
    .stroke()
    .restore();
};

/**
 * El sello de una nota cancelada.
 *
 * El papel es el de siempre, porque es el que la gente ya conoce y sabe donde
 * esta cada cosa, pero una nota devuelta tiene que verse cancelada en el papel
 * de la empresa igual que en el del cliente: el que no lo ve archiva una
 * entrega que se devolvio como si fuera real. Va atravesado sobre el papel y no
 * como una fila mas, porque el papel tiene el aspecto de una nota buena.
 */
const selloDeCancelacion = (doc: PDFKit.PDFDocument, nota: Nota, papel: Papel): void => {
  if (nota.estatus !== 'cancelada') return;
  const izquierda = papel.ancho * 0.1;
  const ancho = papel.ancho * 0.8;
  const alto = papel.alto * 0.1;

  doc.save();
  doc.translate(papel.ancho / 2, papel.alto / 2);
  doc.rotate(-12);
  doc.translate(-papel.ancho / 2, -papel.alto / 2);
  doc
    .lineWidth(3)
    .strokeColor(ROJO)
    .rect(izquierda, papel.alto / 2 - alto / 2, ancho, alto)
    .stroke()
    .font('Helvetica-Bold')
    .fontSize(26)
    .fillColor(ROJO)
    .text(textoSeguro('CANCELADA'), izquierda, papel.alto / 2 - 13, {
      width: ancho,
      align: 'center',
      lineBreak: false,
    })
    .restore();

  if (nota.motivo_cancelacion !== null && nota.motivo_cancelacion !== '') {
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor(ROJO)
      .text(`Motivo: ${textoSeguro(nota.motivo_cancelacion)}`, izquierda, papel.alto * 0.62, {
        width: ancho,
        align: 'center',
      });
  }
};

/**
 * Arma el PDF de una nota.
 *
 * `autoFirstPage: false` y la primera pagina se agrega explicita: el papel
 * empieza en el margen de la plantilla, no en el que pondria pdfkit, y con la
 * pagina automatica ese margen ya viene gastado.
 */
export async function pdfNotaRemision(
  nota: Nota,
  cliente: ClienteImprimible,
  empresa: DatosEmpresa,
): Promise<Buffer> {
  const papel = await medirPlantilla();

  // Los datos van en las MISMAS celdas donde los pone el Excel y ANTES de
  // dibujar: si se escribieran despues, el papel ya estaria impreso.
  escribir(papel, 'B7', nota.folio);
  escribir(papel, 'B8', cliente.nombre);
  escribir(papel, 'E8', fechaCorta(nota.fecha));
  escribir(papel, 'B10', nota.direccion_entrega ?? cliente.direccion ?? '');

  for (let i = 0; i < MAX_RENGLONES; i += 1) {
    const fila = PRIMERA_FILA_DETALLE + i * FILAS_POR_RENGLON;
    const renglon = nota.renglones[i];
    if (renglon === undefined) continue;
    escribir(papel, `A${fila}`, numeroComoTexto(renglon.cantidad_bultos, 2));
    escribir(papel, `B${fila}`, renglon.producto_nombre);
    escribir(papel, `D${fila}`, kilosComoTexto(renglon.kg_bulto));
    escribir(papel, `E${fila}`, montoComoTexto(renglon.precio_unit_kg));
    escribir(papel, `F${fila}`, montoComoTexto(renglon.subtotal));
  }
  // El total de la nota, el de la base, no el de sumar la hoja.
  escribir(papel, 'E40', montoComoTexto(nota.subtotal));

  const doc = new PDFDocument({
    size: [PAGINA.ancho, PAGINA.alto],
    // Margenes EN CERO a proposito. Si se le pasa un numero a `margin`, pdfkit
    // lo aplica a los cuatro lados, y con los margenes de la plantilla (arriba
    // 53.8, abajo 0) el alto usable queda en 684 puntos: el papel entra hasta
    // los 738 y entonces pdfkit lo parte en varias hojas. La posicion la pone
    // el `translate` de mas abajo, y con margen cero pdfkit nunca anade pagina
    // solo.
    margin: 0,
    autoFirstPage: false,
    bufferPages: true,
    info: {
      Title: `Nota de remision ${nota.folio}`,
      Author: empresa.nombre,
    },
  });

  doc.addPage();

  // El papel se dibuja con la misma escala con la que lo imprimiría Excel: la
  // plantilla es mas alta que la hoja, y sin esto se sale por abajo.
  const escala = escalaDelPapel(papel);
  doc.save();
  doc.translate(MARGEN.izquierda, MARGEN.arriba);
  doc.scale(escala);

  /*
   * pdfkit no se entera de la escala. Su cursor `doc.y` avanza en unidades SIN
   * escalar, asi que al recorrer los 828 puntos de la plantilla se pasa de los
   * 792 de la hoja y pdfkit mete una pagina nueva en medio del formulario: el
   * papel salia repartido en tres hojas.
   *
   * La salida es subirle la altura a la pagina mientras se dibuja. El
   * `MediaBox` se escribio al crear la pagina y no se vuelve a tocar, asi que
   * el PDF sigue siendo de 612 x 792; lo que cambia es el numero con el que
   * pdfkit decide si cabe un texto, que es justo lo que hay que relajar.
   */
  const altoDeLaHoja = doc.page.height;
  doc.page.height = altoDeLaHoja + papel.alto + 40;

  for (const casilla of papel.casillas) recuadro(doc, casilla);
  for (const casilla of papel.casillas) textoDeCelda(doc, casilla);

  // La diagonal de los bloques vacios, encima de su propio texto.
  for (let i = 0; i < MAX_RENGLONES; i += 1) {
    const fila = PRIMERA_FILA_DETALLE + i * FILAS_POR_RENGLON;
    if (nota.renglones[i] !== undefined) continue;
    for (const letra of ['A', 'B', 'D', 'E', 'F']) {
      const casilla = papel.casillas.find((c) => c.maestro === `${letra}${fila}`);
      if (casilla !== undefined) tachar(doc, casilla);
    }
  }

  selloDeCancelacion(doc, nota, papel);

  doc.restore();
  doc.page.height = altoDeLaHoja;

  return aBuffer(doc);
}

/** Cuantos renglones de la nota NO caben en el papel, igual que en el Excel. */
export const renglonesFuera = (nota: Nota): number =>
  Math.max(0, nota.renglones.length - MAX_RENGLONES);
