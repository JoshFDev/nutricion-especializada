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

const textoDelPdf = (buf: Buffer): string => {
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

/** Cuantas paginas trae. */
const paginasDe = (buf: Buffer): number =>
  (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;

/**
 * Cuantas diagonales lleva el papel, que son las de los renglones vacios.
 *
 * Se cuentan por el `moveto` de cada una: los recuadros de las celdas se
 * dibujan con `rect` y no mueven el punto, asi que el numero de `moveto` ES el
 * numero de diagonales. Es la forma de preguntar "hay mas rayas en este papel
 * que en el otro" sin depender del color ni de donde esten.
 */
const diagonalesDe = (buf: Buffer): number => {
  let total = 0;
  for (const flujo of flujos(buf)) {
    // `\bm\b` y no `/\d\s+\d\s+m/`: pdfkit escribe el punto como `x y m`
    // y la `m` de `cm` (la matriz de la pagina) NO cuenta, porque va pegada a
    // una letra y no es una palabra suelta.
    total += (flujo.match(/\bm\b/g) ?? []).length;
  }
  return total;
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

    // Nueve renglones: el papel esta lleno y no lleva ni una diagonal. Con
    // tres: seis bloques vacios por cinco casillas, treinta rayas.
    expect(diagonalesDe(conTodos)).toBe(0);
    expect(diagonalesDe(conTres)).toBe(6 * 5);
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
});
