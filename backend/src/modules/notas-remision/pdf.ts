import PDFDocument from 'pdfkit';
import { kilosComoTexto, montoComoTexto, numeroComoTexto } from '../../core/valores.js';
import type { ClienteImprimible, Nota } from './modelo.js';

/**
 * La nota de remision impresa.
 *
 * Es una funcion PURA: recibe la nota ya leida y devuelve un `Buffer` de
 * bytes. No abre la base, no conoce Express y no escribe en disco, asi que
 * se puede probar sin levantar nada (ver `tests/unit/notas.pdf.test.ts`) y
 * lo unico que puede salir mal es que los datos esten raros.
 *
 * Por que se ARMA ENTERO en memoria y no se hace `doc.pipe(res)`: `pipe`
 * manda las cabeceras antes de saber si el documento se pudo dibujar, y a
 * partir de ahi un error ya no se puede convertir en un 404 ni en un 500
 * con su mensaje: el manejador de errores de `app.ts` intentaria poner un
 * JSON encima de una respuesta que ya empezo a salir como PDF, y reventaria
 * con "Cannot set headers after they are sent". Armando el buffer primero,
 * un fallo es un fallo de verdad y el cliente recibe el mismo JSON que en
 * cualquier otra ruta. Una nota son decenas de renglones: el buffer pesa
 * unos cuantos kilobytes.
 *
 * Lo que se imprime es lo que la base guardo, nunca un recalculo. El importe
 * que vale es el `subtotal` de `notas_remision`, que mantiene
 * `fn_recalcular_subtotal_nota`, y los precios son los del renglon, que son
 * los que se cobraron aunque hoy la lista diga otra cosa.
 */

/** Membrete: sale impreso arriba. Viene del entorno, no de la base. */
export interface DatosEmpresa {
  nombre: string;
  rfc: string;
  direccion: string;
  telefono: string;
}

const MARGEN = 40;
const TAMANO_EMPRESA = 15;
const TAMANO_DATO = 9.5;
const TAMANO_TEXTO = 8.5;
const TAMANO_CELDA = 8;
const TAMANO_PIE = 7.5;
const ALTO_CELDA = 12;
const SEPARADOR = 5;
const GRIS_LINEA = '#9aa0a6';
const GRIS_TENUE = '#5f6368';
const GRIS_FONDO = '#eceff1';
const ROJO = '#b00020';

/** Como se lee el estatus en el papel. La clave de la base no se imprime. */
const ETIQUETA_ESTATUS: Record<Nota['estatus'], string> = {
  pendiente: 'Pendiente de pago',
  parcial: 'Pago parcial',
  pagada: 'Pagada',
  cancelada: 'CANCELADA',
};

/**
 * Las columnas del detalle.
 *
 * Los anchos suman 502 y el ancho util es 532 (letter menos 40 de margen
 * por lado), asi que los 30 que sobran se van en los 6 separadores de 5pt.
 * La descripcion se queda con 176 porque es la unica columna que necesita
 * texto largo, y aun asi es la que primero se parte en dos lineas: `doc.text`
 * con `width` ENVUELVE y no recorta, y un nombre de producto cortado a la
 * mitad es un renglon que nadie puede revisar.
 *
 * Se declaran una por una y no como arreglo anonimo porque las filas se
 * arman nombrando la columna: con `noUncheckedIndexedAccess` un
 * `COLUMNAS[1]` es `T | undefined` y habria que comprobarlo en cada celda.
 */
const COL_CODIGO = { titulo: 'Codigo', ancho: 46, alineacion: 'left' as const };
const COL_DESCRIPCION = { titulo: 'Descripcion', ancho: 176, alineacion: 'left' as const };
const COL_ALMACEN = { titulo: 'Almacen', ancho: 66, alineacion: 'left' as const };
const COL_BULTOS = { titulo: 'Bultos', ancho: 42, alineacion: 'right' as const };
const COL_KG_BULTO = { titulo: 'Kg/bulto', ancho: 48, alineacion: 'right' as const };
const COL_PRECIO = { titulo: 'Precio/kg', ancho: 58, alineacion: 'right' as const };
const COL_IMPORTE = { titulo: 'Importe', ancho: 66, alineacion: 'right' as const };

const COLUMNAS = [
  COL_CODIGO,
  COL_DESCRIPCION,
  COL_ALMACEN,
  COL_BULTOS,
  COL_KG_BULTO,
  COL_PRECIO,
  COL_IMPORTE,
];

/**
 * Unicode que NO esta en WinAnsiEncoding, el juego de las 14 fuentes
 * estandar que pdfkit usa sin embeber nada.
 *
 * Son los caracteres que se cuelan solos: una comilla tipografica o un
 * guion largo copiados de otro documento, o un teclado en otro idioma. Sin
 * esta tabla pdfkit dibuja el caracter fuente vacio y el documento sale con
 * un cuadrado en medio del nombre del producto.
 */
const SUSTITUCIONES: Record<string, string> = {
  '\u2018': "'",
  '\u2019': "'",
  '\u201a': "'",
  '\u201b': "'",
  '\u201c': '"',
  '\u201d': '"',
  '\u201e': '"',
  '\u2013': '-',
  '\u2014': '-',
  '\u2026': '...',
  '\u2022': '-',
  '\u00a0': ' ',
  '\u00ad': '',
};

/**
 * Texto que pdfkit sabe dibujar.
 *
 * Tres pasos, y los tres importan:
 *
 * 1. `normalize('NFC')`: un nombre tecleado en macOS llega DESCOMPUES ("o"
 *    mas un acento combinante, dos code points). Sin esto el acento se
 *    pierde, y el mismo cliente sale con otro nombre en el papel que en la
 *    pantalla. `normalize` es parte del lenguaje, no de ICU, asi que no
 *    depende de los datos del runtime.
 *
 * 2. Los caracteres de control se descartan en vez de imprimirse: un salto
 *    de linea pegado a un renglon descuadra la tabla entera.
 *
 * 3. Lo que no existe en WinAnsi se marca con `?`. Un `?` en el papel se ve
 *    y se pregunta; un caracter invisible solo se descubre cuando el
 *    cliente reclama que su nombre esta mal escrito.
 *
 * Las marcas combinantes sueltas (0x300-0x36f) se BORRAN y no se cambian
 * por `?`: si sobrevivieron a la normalizacion, borrarlas deja "REMISION",
 * que es el texto correcto sin tilde, mientras que `?` dejaria "REMISI?N",
 * que ya no es una palabra.
 */
const textoSeguro = (valor: string | null | undefined): string => {
  if (valor === null || valor === undefined) return '';
  let salida = '';
  for (const caracter of valor.normalize('NFC')) {
    const code = caracter.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) continue;
    if (code >= 0x300 && code <= 0x36f) continue;
    const sustituto = SUSTITUCIONES[caracter];
    if (sustituto !== undefined) {
      salida += sustituto;
    } else {
      salida += code <= 0xff ? caracter : '?';
    }
  }
  return salida;
};

/** pdfkit es un stream: aqui se junta entero en un `Buffer`. */
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

const anchoUtil = (doc: PDFKit.PDFDocument): number => doc.page.width - MARGEN * 2;

/** Cuanto mide un texto con el ancho dado, sin dibujarlo. */
const altoDe = (doc: PDFKit.PDFDocument, texto: string, ancho: number, tamano: number): number =>
  doc.font('Helvetica').fontSize(tamano).heightOfString(texto, { width: ancho });

/**
 * ¿Cabe lo que sigue? Si no, pagina nueva.
 *
 * `doc.text` con coordenadas absolutas NO salta de pagina solo: eso solo
 * pasa con el flujo de texto normal. Con `doc.y` elegido, escribir un renglon
 * que no cabe lo manda encima del pie o fuera de la hoja, y pdfkit no
 * avisa. Por eso cada bloque pregunta antes de dibujarse.
 *
 * `alCambiarPagina` no es un detalle: es lo que redibuja los titulos de la
 * tabla. Sin eso la segunda pagina es una lista de numeros sin columnas, que
 * es justo el papel que nadie puede usar para detectar un kilo de mas.
 */
const asegurarEspacio = (
  doc: PDFKit.PDFDocument,
  alto: number,
  alCambiarPagina: () => void,
): void => {
  if (doc.y + alto <= doc.page.height - MARGEN) return;
  doc.addPage();
  alCambiarPagina();
};

const dibujarLinea = (doc: PDFKit.PDFDocument, y: number, color = GRIS_LINEA): void => {
  doc
    .save()
    .lineWidth(0.5)
    .strokeColor(color)
    .moveTo(MARGEN, y)
    .lineTo(doc.page.width - MARGEN, y)
    .stroke()
    .restore();
};

/** Una linea de texto en un ancho, en negrita o normal. */
const linea = (
  doc: PDFKit.PDFDocument,
  texto: string,
  x: number,
  y: number,
  ancho: number,
  opciones: {
    negrita?: boolean;
    tamano?: number;
    alineacion?: 'left' | 'right' | 'center';
    color?: string;
  } = {},
): number => {
  const tamano = opciones.tamano ?? TAMANO_DATO;
  doc
    .font(opciones.negrita ? 'Helvetica-Bold' : 'Helvetica')
    .fontSize(tamano)
    .fillColor(opciones.color ?? '#111111');
  const alto = doc.font('Helvetica').fontSize(tamano).heightOfString(texto, { width: ancho });
  doc.text(texto, x, y, {
    width: ancho,
    align: opciones.alineacion ?? 'left',
  });
  return alto;
};

/** Memberse, titulo del documento, folio y fecha. */
const dibujarMembrete = (doc: PDFKit.PDFDocument, empresa: DatosEmpresa, nota: Nota): void => {
  const derecha = doc.page.width - MARGEN;
  const anchoCaja = 176;
  const xCaja = derecha - anchoCaja;
  const anchoIzquierda = xCaja - MARGEN - 20;

  let y = MARGEN;
  y += linea(doc, textoSeguro(empresa.nombre), MARGEN, y, anchoIzquierda, {
    negrita: true,
    tamano: TAMANO_EMPRESA,
  });
  y += 2;

  const datos = [empresa.rfc, empresa.direccion, empresa.telefono]
    .map(textoSeguro)
    .filter((dato) => dato !== '');
  for (const dato of datos) {
    y += linea(doc, dato, MARGEN, y, anchoIzquierda, {
      tamano: TAMANO_TEXTO,
      color: GRIS_TENUE,
    });
  }

  y = MARGEN;
  y += linea(doc, 'NOTA DE REMISIÓN', xCaja, y, anchoCaja, {
    negrita: true,
    tamano: 11,
    alineacion: 'center',
  });
  y += 6;
  y += linea(doc, `Folio: ${textoSeguro(nota.folio)}`, xCaja, y, anchoCaja, {
    negrita: true,
    tamano: 12,
    alineacion: 'center',
  });
  y += 3;
  y += linea(doc, `Fecha: ${textoSeguro(nota.fecha)}`, xCaja, y, anchoCaja, {
    tamano: TAMANO_TEXTO,
    color: GRIS_TENUE,
    alineacion: 'center',
  });
  y += 3;
  linea(doc, ETIQUETA_ESTATUS[nota.estatus], xCaja, y, anchoCaja, {
    negrita: true,
    tamano: 9,
    alineacion: 'center',
    color: nota.estatus === 'cancelada' ? ROJO : GRIS_TENUE,
  });

  dibujarLinea(doc, 96, '#111111');
  doc.y = 108;
};

/**
 * A quien se le entrega y a donde.
 *
 * El destino es `direccion_entrega` si la nota la trae, y si no la direccion
 * que tiene el cliente en su ficha. No se inventa una direccion: una nota
 * sin direccion de entrega es normal (el producto se queda en el almacen), y
 * ponerle la direccion del cliente a la fuerza hace creer que se mando ahi
 * algo que no se mando.
 */
const dibujarDestinatario = (
  doc: PDFKit.PDFDocument,
  nota: Nota,
  cliente: ClienteImprimible,
): void => {
  const mitad = (anchoUtil(doc) - 24) / 2;
  const xDerecha = MARGEN + mitad + 24;
  const y = doc.y;

  const izquierda = [
    cliente.nombre,
    cliente.razon_social,
    // El RFC va con su etiqueta y no suelto: un `GAX0401019AB` a secas
    // pegado al nombre no se sabe si es parte del nombre o del RFC.
    cliente.rfc === null ? null : `RFC: ${cliente.rfc}`,
    cliente.codigo === null ? null : `Cliente: ${cliente.codigo}`,
    cliente.establo,
    cliente.especie,
    cliente.telefono,
  ];
  const derecha = [nota.direccion_entrega ?? cliente.direccion];

  const altoDeBloque = (valores: (string | null | undefined)[]): number => {
    const lineas = valores.map(textoSeguro).filter((dato) => dato !== '');
    return lineas.reduce((total, dato) => total + altoDe(doc, dato, mitad, TAMANO_DATO), 0);
  };

  // El alto se toma del bloque mas largo de los dos, no del ultimo que se
  // escribio: el de la izquierda tiene cinco lineas y el de la derecha
  // normalmente una, y si se midiera al terminar el derecho, el nombre del
  // cliente se comeria la direccion de entrega.
  const alto = Math.max(altoDeBloque(izquierda), altoDeBloque(derecha));

  const bloque = (titulo: string, valores: (string | null | undefined)[], x: number): void => {
    let cursor = y;
    cursor += linea(doc, titulo, x, cursor, mitad, {
      negrita: true,
      tamano: TAMANO_TEXTO,
      color: GRIS_TENUE,
    });
    cursor += 3;
    for (const dato of valores.map(textoSeguro)) {
      if (dato === '') continue;
      cursor += linea(doc, dato, x, cursor, mitad, {});
    }
  };

  bloque('CLIENTE', izquierda, MARGEN);
  bloque('DESTINO DE ENTREGA', derecha, xDerecha);

  doc.y = y + alto + 4;
  dibujarLinea(doc, doc.y, GRIS_LINEA);
  doc.y += 12;
};

/**
 * La caja roja de una nota cancelada.
 *
 * Es lo primero que se ve despues del membrete, y no un renglon mas al
 * final, porque un papel con el mismo membrete y la misma tabla que el de
 * una nota buena se puede archivar donde sea. El motivo va escrito porque
 * `chk_notas_motivo_cancelacion` lo exige: una cancelacion sin motivo es un
 * boton que borra trabajo.
 */
const dibujarCancelacion = (doc: PDFKit.PDFDocument, nota: Nota): void => {
  if (nota.estatus !== 'cancelada') return;

  const ancho = anchoUtil(doc);
  const motivo = textoSeguro(nota.motivo_cancelacion);
  const lineas = motivo === '' ? [] : motivo.split('\n');
  const alto =
    30 + lineas.reduce((total, t) => total + altoDe(doc, t, ancho - 24, TAMANO_TEXTO), 0);

  asegurarEspacio(doc, alto, () => {
    doc.y = MARGEN;
  });

  const y = doc.y;
  doc.save().lineWidth(1).strokeColor(ROJO).rect(MARGEN, y, ancho, alto).stroke().restore();

  let cursor = y + 8;
  cursor += linea(doc, 'DOCUMENTO CANCELADO', MARGEN + 12, cursor, ancho - 24, {
    negrita: true,
    tamano: 10,
    color: ROJO,
    alineacion: 'center',
  });
  if (motivo !== '') {
    for (const texto of lineas) {
      cursor += linea(doc, texto, MARGEN + 12, cursor, ancho - 24, {
        tamano: TAMANO_TEXTO,
        color: ROJO,
        alineacion: 'center',
      });
    }
  }

  doc.y = y + alto + 14;
};

/** La fila de titulos, que se repite en cada pagina. */
const dibujarTitulos = (doc: PDFKit.PDFDocument): void => {
  const y = doc.y;
  doc.rect(MARGEN, y, anchoUtil(doc), ALTO_CELDA + 3).fill(GRIS_FONDO);
  let x = MARGEN;
  for (const columna of COLUMNAS) {
    linea(doc, columna.titulo, x + 3, y + 4, columna.ancho - 6, {
      negrita: true,
      tamano: TAMANO_CELDA,
      alineacion: columna.alineacion,
    });
    x += columna.ancho + SEPARADOR;
  }
  dibujarLinea(doc, y + ALTO_CELDA + 3, '#5f6368');
  doc.y = y + ALTO_CELDA + 8;
};

/** Los renglones de la nota, con salto de pagina y titulos repetidos. */
const dibujarRenglones = (doc: PDFKit.PDFDocument, nota: Nota): void => {
  asegurarEspacio(doc, 120, () => {
    doc.y = MARGEN;
  });
  dibujarTitulos(doc);

  for (const renglon of nota.renglones) {
    const celdas = [
      { columna: COL_CODIGO, texto: textoSeguro(renglon.producto_codigo) },
      { columna: COL_DESCRIPCION, texto: textoSeguro(renglon.producto_nombre) },
      { columna: COL_ALMACEN, texto: textoSeguro(renglon.almacen) },
      { columna: COL_BULTOS, texto: numeroComoTexto(renglon.cantidad_bultos, 2) },
      { columna: COL_KG_BULTO, texto: kilosComoTexto(renglon.kg_bulto) },
      { columna: COL_PRECIO, texto: montoComoTexto(renglon.precio_unit_kg) },
      { columna: COL_IMPORTE, texto: montoComoTexto(renglon.subtotal) },
    ];

    // La fila crece lo que necesite la descripcion, que es la unica celda
    // que puede partirse en dos lineas. El resto siempre cabe en una.
    const altoFila = Math.max(
      ALTO_CELDA,
      ...celdas.map((celda) => altoDe(doc, celda.texto, celda.columna.ancho - 6, TAMANO_CELDA) + 5),
    );

    asegurarEspacio(doc, altoFila, () => dibujarTitulos(doc));

    const y = doc.y;
    let x = MARGEN;
    for (const celda of celdas) {
      linea(doc, celda.texto, x + 3, y + 3, celda.columna.ancho - 6, {
        tamano: TAMANO_CELDA,
        alineacion: celda.columna.alineacion,
      });
      x += celda.columna.ancho + SEPARADOR;
    }
    doc.y = y + altoFila;
    dibujarLinea(doc, doc.y, '#e0e0e0');
  }
  doc.y += 10;
};

/**
 * Totales.
 *
 * Bultos y kilos SI se suman aqui, porque no hay ninguna columna que los
 * traiga: la base guarda el subtotal de la nota pero no el total de kilos
 * entregados, y un total de kilos en papel es lo que revisa quien recibe.
 *
 * El importe NO se suma: se imprime el `subtotal` de la nota. Es el que
 * mantiene `fn_recalcular_subtotal_nota` y el que el sistema usa para el
 * saldo del cliente, asi que si aqui se recalculara y los dos no
 * coincidieran, el papel estaria mostrando una cifra que la base no
 * reconoce.
 */
const dibujarTotales = (doc: PDFKit.PDFDocument, nota: Nota): void => {
  const bultos = nota.renglones.reduce((total, r) => total + r.cantidad_bultos, 0);
  const kilos = nota.renglones.reduce((total, r) => total + r.cantidad_bultos * r.kg_bulto, 0);
  const ancho = 210;
  const x = doc.page.width - MARGEN - ancho;
  const alto = 62;

  asegurarEspacio(doc, alto, () => {
    doc.y = MARGEN;
  });

  const y = doc.y;
  linea(doc, `Bultos: ${numeroComoTexto(bultos, 2)}`, x, y, ancho, {
    tamano: TAMANO_TEXTO,
    alineacion: 'right',
    color: GRIS_TENUE,
  });
  linea(doc, `Kilos: ${kilosComoTexto(kilos)}`, x, y + 12, ancho, {
    tamano: TAMANO_TEXTO,
    alineacion: 'right',
    color: GRIS_TENUE,
  });
  dibujarLinea(doc, y + 30, '#111111');
  linea(doc, 'TOTAL', x, y + 36, ancho, {
    negrita: true,
    tamano: TAMANO_TEXTO,
    alineacion: 'right',
    color: GRIS_TENUE,
  });
  linea(doc, `$${montoComoTexto(nota.subtotal)}`, x, y + 47, ancho, {
    negrita: true,
    tamano: 13,
    alineacion: 'right',
  });

  doc.y = y + alto;
};

/**
 * Las dos firmas.
 *
 * Una remision la firma quien entrega y quien recibe, y sin las dos no sirve
 * para reclamar que falto un bulto. Van siempre juntas en la misma pagina:
 * una firma sola en el pie de la ultima hoja es un papel que se perdio, y
 * por eso el bloque pide su espacio completo antes de dibujarse en vez de
 * dejar que pdfkit lo parta.
 */
const dibujarFirmas = (doc: PDFKit.PDFDocument, nota: Nota, cliente: ClienteImprimible): void => {
  const ancho = (anchoUtil(doc) - 24) / 2;
  const alto = 74;

  asegurarEspacio(doc, alto, () => {
    doc.y = MARGEN;
  });

  const y = doc.y;
  const aviso =
    'Recibí los productos y las cantidades descritos en este documento, en las condiciones que aquí se anotan.';
  doc
    .font('Helvetica')
    .fontSize(TAMANO_TEXTO)
    .fillColor(GRIS_TENUE)
    .text(aviso, MARGEN, y, { width: anchoUtil(doc) });
  doc.y = y + altoDe(doc, aviso, anchoUtil(doc), TAMANO_TEXTO) + 12;

  const firma = (x: number, titulo: string, nombre: string): void => {
    const yFirma = doc.y;
    dibujarLinea(doc, yFirma);
    linea(doc, titulo, x, yFirma + 4, ancho, {
      negrita: true,
      tamano: TAMANO_TEXTO,
      alineacion: 'center',
    });
    if (nombre !== '') {
      linea(doc, nombre, x, yFirma + 16, ancho, {
        tamano: TAMANO_CELDA,
        alineacion: 'center',
        color: GRIS_TENUE,
      });
    }
  };

  // Una nota sin vendedor es posible (`vendedor_id` es NULL para lo capturado
  // por import/manual), y entonces se imprime la linea de firma sin nombre:
  // un espacio en blanco donde firmaba el operador.
  firma(MARGEN, 'ENTREGÓ', nota.vendedor ?? '');
  firma(MARGEN + ancho + 24, 'RECIBÍ CONFORME', textoSeguro(cliente.nombre));
};

/**
 * Pie de pagina, con el folio y la numeracion.
 *
 * Se dibuja al final, con `switchToPage`, porque "pagina 2 de 3" no se puede
 * escribir hasta que se sepa cuantas hay. Por eso el documento se abre con
 * `bufferPages: true`: sin eso, pdfkit manda la pagina a la salida en
 * cuanto se llena y despues no hay forma de volver a ella.
 *
 * `margins.bottom = 0` es obligatorio y no es cosmetico. El pie va POR DEBAJO
 * del margen, que es donde tiene que estar, y `doc.text` agrega una pagina
 * automaticamente cuando la coordenada se pasa del margen inferior. Sin
 * esto, dibujar el pie crea la pagina siguiente: un PDF de una hoja con el
 * pie puesto se va a tres hojas, con una vacia al final de cada pagina real.
 */
const dibujarPies = (doc: PDFKit.PDFDocument, nota: Nota): void => {
  const rango = doc.bufferedPageRange();
  for (let i = 0; i < rango.count; i += 1) {
    doc.switchToPage(rango.start + i);
    doc.page.margins.bottom = 0;

    const y = doc.page.height - MARGEN + 12;
    const ancho = (anchoUtil(doc) - 12) / 2;
    linea(doc, `Nota de remisión ${textoSeguro(nota.folio)}`, MARGEN, y, ancho, {
      tamano: TAMANO_PIE,
      color: GRIS_TENUE,
    });
    linea(doc, `Página ${i + 1} de ${rango.count}`, MARGEN + ancho + 12, y, ancho, {
      tamano: TAMANO_PIE,
      color: GRIS_TENUE,
      alineacion: 'right',
    });
  }
};

/**
 * Arma el PDF de una nota.
 *
 * `autoFirstPage: false` y la primera pagina se agrega explicita: el
 * membrete empieza en MARGEN, no en el margen que pdfkit pondria, y con la
 * pagina automatica el margen ya viene gastado.
 */
export async function pdfNotaRemision(
  nota: Nota,
  cliente: ClienteImprimible,
  empresa: DatosEmpresa,
): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'LETTER',
    margin: MARGEN,
    autoFirstPage: false,
    bufferPages: true,
    info: {
      Title: `Nota de remision ${nota.folio}`,
      Author: empresa.nombre,
    },
  });

  doc.addPage();
  dibujarMembrete(doc, empresa, nota);
  dibujarDestinatario(doc, nota, cliente);
  dibujarCancelacion(doc, nota);
  dibujarRenglones(doc, nota);
  dibujarTotales(doc, nota);
  dibujarFirmas(doc, nota, cliente);
  dibujarPies(doc, nota);

  return aBuffer(doc);
}
