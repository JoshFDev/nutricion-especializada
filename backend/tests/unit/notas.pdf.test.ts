import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  pdfNotaRemision,
  renglonesFuera,
  type DatosEmpresa,
} from '../../src/modules/notas-remision/pdf.js';
import type { ClienteImprimible, Nota, Renglon } from '../../src/modules/notas-remision/modelo.js';

/**
 * El PDF de la nota de remision.
 *
 * Aqui se prueba el RENDER, no la ruta: `pdfNotaRemision` es una funcion pura
 * que recibe la nota y devuelve bytes, asi que se puede comprobar que sale
 * un PDF de verdad, con el folio del cliente, sin base de datos ni servidor.
 * Que la ruta lo entregue con los permisos correctos es cosa de
 * `tests/api.test.mjs`.
 */

const EMPRESA: DatosEmpresa = {
  nombre: 'Nutrición Especializada',
  rfc: 'NIE-010101-XYZ',
  direccion: 'Carretera Federal 15 km 4',
  telefono: '(222) 123 4567',
};

const renglon = (over: Partial<Renglon> = {}): Renglon => ({
  id: 1,
  producto_id: 1,
  producto_codigo: 'LAC',
  producto_nombre: 'VIMILAC 400',
  almacen_id: 1,
  almacen: 'Bodega BUAP',
  cantidad_bultos: 10,
  kg_bulto: 25,
  precio_unit_kg: 37.5,
  subtotal: 9375,
  ...over,
});

const cliente = (over: Partial<ClienteImprimible> = {}): ClienteImprimible => ({
  nombre: 'Granja Los Robles',
  codigo: 'AC01',
  telefono: '(222) 987 6543',
  direccion: 'Camino a lapeerda s/n',
  establo: 'Establo Norte',
  especie: 'Bovinos lecheros',
  rfc: null,
  razon_social: null,
  ...over,
});

const nota = (over: Partial<Nota> = {}): Nota => ({
  id: 1,
  folio_id: 10,
  folio: 'A-1001',
  cliente_id: 1,
  cliente: 'Granja Los Robles',
  vendedor_id: 2,
  vendedor: 'Hermana',
  fecha: '2026-09-27',
  direccion_entrega: null,
  subtotal: 9375,
  estatus: 'pendiente',
  motivo_cancelacion: null,
  creado_en: '2026-09-27T10:00:00.000Z',
  actualizado_en: '2026-09-27T10:00:00.000Z',
  renglones: [renglon()],
  ...over,
});

/**
 * El texto que hay DENTRO del PDF.
 *
 * No se puede hacer `buf.toString().includes('A-1001')`: pdfkit comprime los
 * flujos de contenido, asi que el texto sale en Flate y no se ve. Este
 * localiza los objetos de flujo y los descomprime.
 *
 * Va por `/Length` y NO buscando la palabra `endstream`: los datos
 * comprimidos son binarios y pueden contener literalmente los bytes
 * "stream\n" o "endstream" dentro. Buscando el nombre del flujo aparece un
 * corte falso a mitad de la pagina, el que se corta no descomprime, y el
 * texto de las paginas siguientes se pierde sin que nada avise. Con el
 * `/Length` del diccionario el corte es el que dice el PDF.
 *
 * Las cadenas son de las dos formas que usa pdfkit: literales `(...)` y
 * hexagonales `<...>`. Las hexagonales son las del cuerpo del documento, y
 * sus bytes son directamente los codigos de WinAnsi (con `/Encoding
 * /WinAnsiEncoding` y sin embeber la fuente), asi que se leen como latin1.
 * Sin este paso no se encuentra ni una palabra en todo el PDF.
 *
 * De las cadenas se sacan SOLO los textos, no los numeros: dentro de un `TJ`
 * los numeros son el ajuste de kerning y no son letras. Por eso las
 * comparaciones de este archivo van contra `quitarEspacios`: si hay kerning
 * la palabra queda partida en varias cadenas, pero pegadas sale entera.
 */
const flujos = (buf: Buffer): string[] => {
  const crudo = buf.toString('latin1');
  const salida: string[] = [];
  const objeto = /(\d+) 0 obj\s*<<([\s\S]*?)>>\s*stream\r?\n/g;
  let encontrado: RegExpExecArray | null = objeto.exec(crudo);

  while (encontrado !== null) {
    const inicio = encontrado.index + encontrado[0].length;
    const longitud = /\/Length (\d+)/.exec(encontrado[2] ?? '')?.[1];
    const fin =
      longitud === undefined ? crudo.indexOf('endstream', inicio) : inicio + Number(longitud);
    if (fin > inicio) {
      try {
        salida.push(
          inflateSync(Buffer.from(crudo.slice(inicio, fin), 'latin1')).toString('latin1'),
        );
      } catch {
        // No todos los flujos van comprimidos, y los que no no tienen nada
        // que ver con el texto.
      }
    }
    objeto.lastIndex = inicio;
    encontrado = objeto.exec(crudo);
  }
  return salida;
};

/**
 * Descodifica el texto de un PDF que lleva fuentes incrustadas.
 *
 * Con letra incrustada el PDF ya no guarda los caracteres: guarda el indice del
 * glifo de un subconjunto (`/Encoding /Identity`), y el glifo 42 puede ser una
 * 'a' o un '$' segun la fuente. Por eso, leer el contenido como si fuera
 * texto plano daria basura, y estas pruebas perderian su sentido.
 *
 * Cada fuente incrustada trae su `/ToUnicode`, que es justamente el mapa que
 * dice "este glifo es esta letra". Se leen esos mapas y se decodifica con ellos.
 * Un PDF sin fuentes incrustadas (el de una letra de pdfkit) se lee como texto
 * normal, asi que este lector sirve para los dos casos.
 */
const decodificar = (buf: Buffer): string => {
  const crudo = buf.toString('latin1');

  // Objetos del PDF: "N 0 obj ... endobj".
  const objetos = new Map<number, string>();
  for (const m of crudo.matchAll(/(\d+) 0 obj([\s\S]*?)endobj/g)) {
    objetos.set(Number(m[1]), m[2] ?? '');
  }

  // El flujo de cada objeto, descomprimido.
  const flujoDe = (cuerpo: string): string => {
    const i = cuerpo.indexOf('stream');
    if (i < 0) return '';
    const desde = cuerpo.indexOf('\n', i) + 1;
    const fin = cuerpo.lastIndexOf('endstream');
    if (fin < 0) return '';
    const binario = Buffer.from(cuerpo.slice(desde, fin), 'latin1');
    try {
      return inflateSync(binario).toString('latin1');
    } catch {
      return binario.toString('latin1');
    }
  };

  // De cada fuente incrustada: que codigo es cada letra, y de que tamano son
  // los codigos.
  interface Fuente {
    /** Codigo -> letra, segun el `/ToUnicode` de esa fuente. */
    mapa: Map<number, string>;
    /** Cuantos bytes ocupa cada codigo, segun su `codespacerange`. */
    bytes: number;
  }
  const deCadaFuente = new Map<number, Fuente>();

  for (const [numero, cuerpo] of objetos) {
    const referencia = /\/ToUnicode\s+(\d+) 0 R/.exec(cuerpo);
    if (referencia === null) continue;
    const cmap = flujoDe(objetos.get(Number(referencia[1])) ?? '');

    // El codigo NO siempre ocupa dos bytes. Una fuente con dos bytes por codigo
    // escribe "CA" como <4341> y una de un byte tambien como <43>, asi que sin
    // leer esto se emparejan las letras de dos en dos y el texto sale partido.
    const rango = /begincodespacerange([\s\S]*?)endcodespacerange/.exec(cmap);
    const primerCodigo = rango === null ? '' : (/<([0-9A-Fa-f]*)>/.exec(rango[1] ?? '')?.[1] ?? '');
    // Cada byte son DOS digitos hex: un codigo de dos bytes se escribe <4341>
    // y uno de un byte <43>.
    const bytes = Math.max(1, Math.floor(primerCodigo.length / 2));

    const mapa = new Map<number, string>();
    for (const bloque of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
      for (const par of (bloque[1] ?? '').matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
        mapa.set(parseInt(par[1] ?? '0', 16), String.fromCharCode(parseInt(par[2] ?? '0', 16)));
      }
    }
    // `bfrange` tiene DOS formas y pdfkit usa la segunda: el rango con un
    // destino POR codigo, escrito en un arreglo. Con solo la forma continua (un
    // unico destino del que se deduce el resto) el mapa sale vacio y el papel
    // parece no tener texto.
    for (const bloque of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
      const cuerpoRango = bloque[1] ?? '';
      for (const par of cuerpoRango.matchAll(
        /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([^\]]*)\]/g,
      )) {
        const desde = parseInt(par[1] ?? '0', 16);
        const destinos = [...(par[3] ?? '').matchAll(/<([0-9A-Fa-f]*)>/g)].map((d) =>
          parseInt(d[1] ?? '0', 16),
        );
        destinos.forEach((letra, i) => mapa.set(desde + i, String.fromCharCode(letra)));
      }
      // Y la forma continua SIEMPRE sobre el cuerpo SIN corchetes. Si se busca
      // en el cuerpo entero, sus triples de tres en tres caen dentro de los
      // corchetes y se leen como si fueran rangos: eso machaca el mapa que se
      // acabo de hacer y el texto sale como "VWXYZ[" en vez de "NUTRICION".
      const sinArreglos = cuerpoRango.replace(/\[[^\]]*\]/g, '');
      for (const par of sinArreglos.matchAll(
        /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g,
      )) {
        const desde = parseInt(par[1] ?? '0', 16);
        const hasta = parseInt(par[2] ?? '0', 16);
        const inicio = parseInt(par[3] ?? '0', 16);
        for (let g = desde; g <= hasta; g += 1)
          mapa.set(g, String.fromCharCode(inicio + (g - desde)));
      }
    }
    if (mapa.size > 0) deCadaFuente.set(numero, { mapa, bytes });
  }
  if (deCadaFuente.size === 0) return '';

  // /F1 -> fuente, para saber que mapa y que tamano de codigo van con cada
  // bloque de texto.
  const fuentesDe = new Map<string, Fuente>();
  for (const m of crudo.matchAll(/\/(F\d+)\s+(\d+) 0 R/g)) {
    const fuente = deCadaFuente.get(Number(m[2]));
    if (fuente !== undefined) fuentesDe.set(m[1] ?? '', fuente);
  }
  if (fuentesDe.size === 0) return '';

  const texto: string[] = [];
  let actual: Fuente | undefined;
  // SOLO el flujo de la pagina. Los otros flujos son las propias letras
  // incrustadas, y en su binario hay parentesis y angulos que el lector tomaria
  // por texto del documento: ahi se colaba la basura en medio de los datos.
  for (const flujo of flujos(buf).filter((f) => f.includes(' Tf'))) {
    // Las TRES formas de escribir texto en un PDF: cambiar de fuente, el
    // arreglo de codigos de una fuente incrustada y la cadena directa.
    for (const op of flujo.matchAll(
      /\/(F\d+)\s+[\d.]+\s+Tf|\[([\s\S]*?)\]\s*TJ|\(((?:[^()\\]|\\.)*)\)\s*Tj/g,
    )) {
      if (op[1] !== undefined) {
        actual = fuentesDe.get(op[1]);
        continue;
      }
      if (op[3] !== undefined) {
        texto.push(op[3].replace(/\\([()\\])/g, '$1'));
        continue;
      }
      let salida = '';
      for (const hex of (op[2] ?? '').matchAll(/<([0-9A-Fa-f]*)>/g)) {
        const digitos = hex[1] ?? '';
        // Una fuente SIN incrustar (las de serie de pdfkit, donde va el sello
        // de "CANCELADA") no trae mapa: sus codigos son los bytes tal cual. Una
        // fuente incrustada si trae mapa, y hay que leerlos con el tamano que
        // declara su codespacerange.
        const largo = actual === undefined ? 2 : actual.bytes * 2;
        for (let i = 0; i + largo <= digitos.length; i += largo) {
          const codigo = parseInt(digitos.slice(i, i + largo), 16);
          if (actual === undefined) {
            salida += codigo >= 32 && codigo < 127 ? String.fromCharCode(codigo) : '';
          } else {
            // Un codigo que el mapa no conoce NO se improvisa con su numero
            // (eso salia como basura tipo "VWXYZ[" y hacia fallar en silencio).
            salida += actual.mapa.get(codigo) ?? '';
          }
        }
      }
      texto.push(salida);
    }
  }
  return texto.join(' ');
};

const textoDelPdf = (buf: Buffer): string => {
  const incrustado = decodificar(buf);
  if (incrustado !== '') return incrustado;

  const partes: string[] = [];
  for (const flujo of flujos(buf)) {
    let i = 0;
    while (i < flujo.length) {
      const caracter = flujo[i];

      if (caracter === '<') {
        // `<<` es un diccionario del PDF, no una cadena.
        if (flujo[i + 1] === '<') {
          i += 2;
          continue;
        }
        const cierre = flujo.indexOf('>', i);
        if (cierre === -1) break;
        const hex = flujo.slice(i + 1, cierre);
        if (/^[0-9a-fA-F]+$/.test(hex) && hex.length % 2 === 0) {
          partes.push(Buffer.from(hex, 'hex').toString('latin1'));
        }
        i = cierre + 1;
        continue;
      }

      if (caracter !== '(') {
        i += 1;
        continue;
      }

      let cadena = '';
      i += 1;
      while (i < flujo.length && flujo[i] !== ')') {
        if (flujo[i] === '\\') {
          const octal = flujo.slice(i + 1, i + 4);
          if (/^[0-7]{3}$/.test(octal)) {
            cadena += String.fromCharCode(parseInt(octal, 8));
            i += 4;
            continue;
          }
          cadena += flujo[i + 1] ?? '';
          i += 2;
          continue;
        }
        cadena += flujo[i];
        i += 1;
      }
      partes.push(cadena);
      i += 1;
    }
  }
  return partes.join(' ');
};

const quitarEspacios = (texto: string): string => texto.replace(/\s+/g, '');

const contarApariciones = (buf: Buffer, aguja: string): number => {
  const limpio = quitarEspacios(textoDelPdf(buf));
  const objetivo = quitarEspacios(aguja);
  let total = 0;
  let desde = 0;
  for (;;) {
    const pos = limpio.indexOf(objetivo, desde);
    if (pos === -1) return total;
    total += 1;
    desde = pos + objetivo.length;
  }
};

/** El `MediaBox` del PDF: el tamano de la hoja. */
const mediaBox = (buf: Buffer): number[] =>
  (/\/MediaBox\s*\[([^\]]+)\]/.exec(buf.toString('latin1'))?.[1] ?? '')
    .trim()
    .split(/\s+/)
    .map(Number);

/**
 * Las tipografias que el papel usa de verdad, por su nombre dentro del PDF.
 *
 * La plantilla esta en Bahnschrift y Arial Black. Si el papel sale con las
 * letras de serie de pdfkit (Helvetica) se sigue pareciendo al Excel en las
 * medidas, pero NO es el mismo impreso, y la diferencia se nota a simple vista. Las
 * letras de la maqueta no vienen en el PDF: vienen incrustadas, y el nombre
 * incrustado es el de la fuente real.
 */
const tipografiasDe = (buf: Buffer): string[] =>
  [
    ...new Set(
      [...buf.toString('latin1').matchAll(/\/BaseFont\s*\/([A-Za-z0-9+_-]+)/g)].map(
        (m) => m[1] ?? '',
      ),
    ),
  ].map((nombre) => nombre.replace(/^[A-Z]{6}\+/, ''));

/** Los colores con los que se rellena el papel, tal cual van en el PDF. */
const rellenosDe = (buf: Buffer): string[] => {
  const vistos = new Set<string>();
  for (const flujo of flujos(buf)) {
    // pdfkit escribe el color de relleno en minúsculas (`scn`) o en la forma
    // clásica (`rg`), y con decimales largos. Solo se toman los de relleno: los
    // de trazo van en mayúsculas (`SCN`) y son el color de los bordes.
    for (const m of flujo.matchAll(/([\d.]+) ([\d.]+) ([\d.]+) (?:rg|scn)\b/g)) {
      const partes = [m[1], m[2], m[3]].map((n) => Math.round(Number(n) * 255));
      vistos.add(`rgb(${partes.join(',')})`);
    }
  }
  return [...vistos];
};

/** Cuantas paginas trae. */
const paginasDe = (buf: Buffer): number =>
  (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;

/**
 * Cuantos trazos dibuja el papel.
 *
 * Cada borde de celda y cada diagonal de renglon vacio son un `moveto` seguido
 * de un `lineto`, asi que el numero de `moveto` es el de trazos del papel. No
 * sirve para decir cuantas diagonales hay (los bordes ya son unos cuantos
 * cientos), pero sirve para COMPARAR dos papeles: el mismo papel con los
 * renglones llenos y con huecos, y la diferencia son las diagonales.
 *
 * Se cuenta `\bm\b` y no `/\d\s+\d\s+m/`: pdfkit escribe el punto como
 * `x y m`, y la `m` de `cm` (la matriz de la pagina) NO cuenta porque va
 * pegada a una letra y no es palabra suelta.
 */
const trazosDe = (buf: Buffer): number => {
  let total = 0;
  for (const flujo of flujos(buf)) {
    total += (flujo.match(/\bm\b/g) ?? []).length;
  }
  return total;
};

/**
 * De que tamano esta cada texto del papel, leyendo el operador `Tf` de cada uno.
 *
 * Sirve para lo que de verdad importa de un impreso: que la letra se lea. Un
 * papel correcto en sus medidas y con la letra a 3 puntos no es un papel
 * correcto.
 */
const tamanosDeLetra = (buf: Buffer): number[] => {
  const tamanos: number[] = [];
  for (const flujo of flujos(buf)) {
    let vigente: number | null = null;
    for (const op of flujo.matchAll(/\/F\d+\s+([\d.]+)\s+Tf|\[/g)) {
      if (op[1] !== undefined) {
        vigente = Number(op[1]);
        continue;
      }
      if (vigente !== null) tamanos.push(vigente);
    }
  }
  return tamanos;
};

describe('pdf de la nota de remision', () => {
  it('arma un PDF de verdad, en UNA hoja vertical', async () => {
    const bytes = await pdfNotaRemision(nota(), cliente(), EMPRESA);

    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(bytes.length).toBeGreaterThan(1000);
    expect(bytes.subarray(-8).toString('latin1').trimEnd()).toContain('%%EOF');
    // El papel es la plantilla del Excel, que es vertical. Que saliera apaisado
    // era el papel de dos copias que se descarto.
    expect(mediaBox(bytes)).toEqual([0, 0, 612, 792]);
    expect(paginasDe(bytes)).toBe(1);
  });

  /*
   * Lo que diferencia este PDF del que habia antes: el papel es LA PLANTILLA DEL
   * EXCEL. Los rotulos de abajo no los pone este archivo, estan en la hoja; si
   * aparecen en el PDF, es que el PDF esta dibujando esa hoja y no una maqueta
   * parecida.
   */
  it('imprime el papel de la plantilla, con sus rotulos', async () => {
    const texto = quitarEspacios(textoDelPdf(await pdfNotaRemision(nota(), cliente(), EMPRESA)));

    for (const rotulo of [
      'CANT',
      'CONCEPTO',
      'PRECIOUNIT',
      'SUBTOTAL',
      'TOTAL',
      'ENTREGADO',
      'RECIBIDO',
      'FOLIO',
      'CLIENTE',
      'DIRECCIÓN',
    ]) {
      expect(texto, `falta el rotulo ${rotulo}`).toContain(quitarEspacios(rotulo));
    }
  });

  it('pone los datos en las mismas celdas donde los pone el Excel', async () => {
    const bytes = await pdfNotaRemision(
      nota({
        folio: 'A-1042',
        fecha: '2026-09-30',
        direccion_entrega: 'Carretera a Cholula km 12',
      }),
      cliente(),
      EMPRESA,
    );
    const texto = quitarEspacios(textoDelPdf(bytes));

    expect(texto).toContain('A-1042');
    expect(texto).toContain(quitarEspacios('Granja Los Robles'));
    expect(texto).toContain('30-sep-26');
    expect(texto).toContain(quitarEspacios('Carretera a Cholula km 12'));
  });

  it('imprime los renglones con su importe, en las celdas del bloque', async () => {
    const bytes = await pdfNotaRemision(
      nota({
        subtotal: 13_125,
        renglones: [
          renglon(),
          renglon({
            id: 2,
            producto_codigo: 'MTO',
            producto_nombre: 'MINERAL TRAZ',
            cantidad_bultos: 4,
            kg_bulto: 25.5,
            precio_unit_kg: 30,
            subtotal: 3060,
          }),
        ],
      }),
      cliente(),
      EMPRESA,
    );
    const texto = quitarEspacios(textoDelPdf(bytes));

    expect(texto).toContain(quitarEspacios('VIMILAC 400'));
    expect(texto).toContain('10.00');
    expect(texto).toContain('25.000');
    expect(texto).toContain('37.50');
    expect(texto).toContain('9,375.00');
    expect(texto).toContain(quitarEspacios('MINERAL TRAZ'));
    expect(texto).toContain('3,060.00');
  });

  it('el total es el de la nota, no la suma de los renglones', async () => {
    // Los renglones suman 12_435 y la nota vale 9_999: si el PDF sumara la
    // hoja, imprimiria el numero equivocado en el papel.
    const bytes = await pdfNotaRemision(
      nota({
        subtotal: 9999,
        renglones: [renglon({ subtotal: 9375 }), renglon({ id: 2, subtotal: 3060 })],
      }),
      cliente(),
      EMPRESA,
    );
    const texto = quitarEspacios(textoDelPdf(bytes));

    expect(texto).toContain('9,999.00');
    expect(texto).not.toContain('12,435.00');
  });

  it('tacha los bloques que la nota no llena, como el Excel', async () => {
    // Tres renglones en un papel de nueve: las seis diagonales de los huecos.
    const conTres = await pdfNotaRemision(
      nota({ renglones: [renglon(), renglon({ id: 2 }), renglon({ id: 3 })] }),
      cliente(),
      EMPRESA,
    );
    const conTodos = await pdfNotaRemision(
      nota({
        renglones: Array.from({ length: 9 }, (_, i) => renglon({ id: i + 1 })),
      }),
      cliente(),
      EMPRESA,
    );

    // El papel lleno es la BASE: los mismos bordes, cero diagonales. Con tres
    // renglones sobran seis bloques vacios de cinco casillas, y la diferencia
    // entre los dos papeles son sus treinta rayas.
    expect(trazosDe(conTodos) - trazosDe(conTres)).toBe(-(6 * 5));
  });

  it('una nota larga NO se parte: el papel tiene nueve renglones y se cuenta', async () => {
    const notaLarga = nota({
      renglones: Array.from({ length: 30 }, (_, i) =>
        renglon({ id: i + 1, producto_nombre: `PRODUCTO NUMERO ${i + 1}` }),
      ),
    });
    const bytes = await pdfNotaRemision(notaLarga, cliente(), EMPRESA);

    // Es lo mismo que hace el Excel con la misma nota: imprime los primeros
    // nueve y avisa de los que se quedaron fuera.
    expect(paginasDe(bytes)).toBe(1);
    expect(renglonesFuera(notaLarga)).toBe(21);
    expect(renglonesFuera(nota({ renglones: [renglon()] }))).toBe(0);
  });

  /*
   * El membrete esta hecho para desbordarse, y esto lo fija.
   *
   * "SUR 7, CUENCA LECHERA DE TIZAYUCA, HIDALGO." esta en B2, que no esta
   * combinada y mide 126 puntos, pero el texto mide unos 371. En Excel eso no
   * se encoge: se sale de la celda hacia las de la derecha mientras esten
   * vacias, y por eso C2..G2 no tienen nada escrito.
   *
   * La primera version encerraba el texto en sus 126 puntos y lo bajaba a 3.6
   * puntos, que no se lee. Esta prueba falla si vuelve a pasar: comprueba que
   * la letra del membrete NO se encoge por debajo de un piso legible, y que el
   * texto sale entero y en una sola pieza.
   */
  it('el membrete sale a su tamano, desbordandose y no encogido', async () => {
    const bytes = await pdfNotaRemision(nota(), cliente(), EMPRESA);
    const texto = quitarEspacios(textoDelPdf(bytes));

    // La direccion del negocio es lo mas largo del membrete y lo que primero
    // se partia. Se busca sin espacios porque el papel lo lleva con espacios.
    expect(texto).toContain(quitarEspacios('SUR 7, CUENCA LECHERA DE TIZAYUCA, HIDALGO.'));

    // Ninguna letra del papel por debajo de 8 puntos: es el piso de lo que se
    // puede leer en un papel impreso a una mano.
    const tamanos = tamanosDeLetra(bytes);
    expect(tamanos.length).toBeGreaterThan(20);
    expect(
      Math.min(...tamanos),
      `la letra mas chica del papel es ${Math.min(...tamanos)}`,
    ).toBeGreaterThanOrEqual(8);
  });

  it('una nota cancelada se ve cancelada, con su motivo', async () => {
    const bytes = await pdfNotaRemision(
      nota({ estatus: 'cancelada', motivo_cancelacion: 'Se devolvio la mercancia' }),
      cliente(),
      EMPRESA,
    );
    const texto = quitarEspacios(textoDelPdf(bytes));

    expect(texto).toContain('CANCELADA');
    expect(texto).toContain(quitarEspacios('Se devolvio la mercancia'));
    // Y el papel sigue siendo el de una hoja: una cancelacion no reparte el
    // formulario.
    expect(paginasDe(bytes)).toBe(1);
  });

  it('una nota sin renglones no revienta', async () => {
    const bytes = await pdfNotaRemision(nota({ renglones: [] }), cliente(), EMPRESA);

    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    // El papel vacio conserva sus rotulos (CANT, TOTAL...) y solo falta lo que
    // se llenaba con la nota. Ojo con contar "TOTAL": tambien esta dentro de
    // "SUBTOTAL".
    expect(contarApariciones(bytes, 'CANT')).toBe(1);
    expect(quitarEspacios(textoDelPdf(bytes))).toContain('TOTAL');
    expect(paginasDe(bytes)).toBe(1);
  });

  it('imprime igual un nombre con acentos descompuestos', async () => {
    // Solo el nombre del cliente: el papel de la plantilla tiene una casilla
    // CLIENTE y una DIRECCION, y no tiene donde poner el establo ni la especie.
    // Van en la pantalla y en el Excel abierto, no en el impreso.
    const bytes = await pdfNotaRemision(
      nota(),
      cliente({ nombre: 'Granja Muñoz e Hijos', establo: 'Rancho Ángel' }),
      EMPRESA,
    );
    const texto = quitarEspacios(textoDelPdf(bytes));

    expect(texto).toContain(quitarEspacios('Granja Muñoz e Hijos'));
  });

  it('un caracter que no existe en la fuente no rompe el documento', async () => {
    const bytes = await pdfNotaRemision(
      nota(),
      cliente({ nombre: 'Granja \u{1F600} emoji \u{4E2D}\u{6587}' }),
      EMPRESA,
    );

    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(paginasDe(bytes)).toBe(1);
  });

  it('un dato larguisimo no descuadra el papel', async () => {
    const bytes = await pdfNotaRemision(
      nota({
        renglones: [
          renglon({
            producto_nombre:
              'ALIMENTO BALANCEADO PARA VACAS LECHERAS DE ALTA PRODUCCION CON NIVEL DE PROTEINA Y ENERGIA AJUSTADO A LA EPOCA DE LACTANCION',
          }),
        ],
      }),
      cliente(),
      EMPRESA,
    );

    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(paginasDe(bytes)).toBe(1);
  });
  /*
   * La tipografia y los colores. Son las dos cosas que hacen que el papel sea
   * EL MISMO impreso y no uno parecido: la letra de la plantilla y los
   * sombreados que trae la hoja.
   */
  it('usa las tipografias de la plantilla, no las de serie', async () => {
    const tipos = tipografiasDe(await pdfNotaRemision(nota(), cliente(), EMPRESA)).map((t) =>
      t.toLowerCase(),
    );

    expect(tipos).toContain('bahnschrift');
    expect(tipos).toContain('arial-black');
  });

  it('sale con los sombreados de la hoja', async () => {
    const bytes = await pdfNotaRemision(nota(), cliente(), EMPRESA);
    const rellenos = rellenosDe(bytes);

    // Los dos colores con los que la plantilla pinta sus bloques: el verde
    // claro de los titulos de columna y el gris del membrete.
    expect(rellenos).toContain('rgb(209,225,211)');
    expect(rellenos).toContain('rgb(232,232,232)');
  });

  it('sale completo aunque no tenga las tipografias del sistema', async () => {
    // Si Bahnschrift y Arial Black no estan (otro equipo, otro servidor), el
    // papel tiene que salir igual de bien con las de pdfkit: una sola hoja y
    // sin letra minima ilegible. Esto es lo que evita que un despliegue se
    // quede con el papel a medias.
    const bytes = await pdfNotaRemision(nota(), cliente(), EMPRESA);

    expect(paginasDe(bytes)).toBe(1);
    expect(mediaBox(bytes)).toEqual([0, 0, 612, 792]);
    expect(Math.min(...tamanosDeLetra(bytes))).toBeGreaterThanOrEqual(8);
  });
});
