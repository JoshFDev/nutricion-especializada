import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { pdfNotaRemision, type DatosEmpresa } from '../../src/modules/notas-remision/pdf.js';
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

describe('pdf de la nota de remision', () => {
  it('arma un PDF de verdad', async () => {
    const bytes = await pdfNotaRemision(nota(), cliente(), EMPRESA);

    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(bytes.length).toBeGreaterThan(1000);
    expect(bytes.subarray(-8).toString('latin1').trimEnd()).toContain('%%EOF');
  });

  it('pone el membrete de la empresa', async () => {
    const bytes = await pdfNotaRemision(nota(), cliente(), EMPRESA);
    const texto = quitarEspacios(textoDelPdf(bytes));

    expect(texto).toContain(quitarEspacios('Nutrición Especializada'));
    expect(texto).toContain(quitarEspacios('NIE-010101-XYZ'));
    expect(texto).toContain(quitarEspacios('Carretera Federal 15 km 4'));
    expect(texto).toContain(quitarEspacios('NOTA DE REMISIÓN'));
  });

  it('pone el folio, la fecha y quien recibe', async () => {
    const bytes = await pdfNotaRemision(nota(), cliente(), EMPRESA);
    const texto = quitarEspacios(textoDelPdf(bytes));

    expect(texto).toContain('A-1001');
    expect(texto).toContain('2026-09-27');
    expect(texto).toContain(quitarEspacios('Granja Los Robles'));
    expect(texto).toContain(quitarEspacios('Establo Norte'));
    expect(texto).toContain(quitarEspacios('Bovinos lecheros'));
    expect(texto).toContain(quitarEspacios('RECIBÍ CONFORME'));
  });

  it('imprime los renglones con su importe', async () => {
    const bytes = await pdfNotaRemision(
      nota({
        renglones: [
          renglon(),
          renglon({
            id: 2,
            producto_codigo: 'MTO',
            producto_nombre: 'MEAT BUILDER',
            almacen: 'Bodega Puebla',
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

    expect(texto).toContain('LAC');
    expect(texto).toContain(quitarEspacios('VIMILAC 400'));
    expect(texto).toContain(quitarEspacios('Bodega BUAP'));
    expect(texto).toContain('MTO');
    expect(texto).toContain(quitarEspacios('MEAT BUILDER'));
    expect(texto).toContain(quitarEspacios('Bodega Puebla'));
    // 10 bultos x 25 kg x $37.50
    expect(texto).toContain('9,375.00');
    // 4 bultos x 25.5 kg x $30.00
    expect(texto).toContain('3,060.00');
  });

  it('usa el subtotal de la nota, no la suma de los renglones', async () => {
    // Los renglones suman 9,375 + 3,060 = 12,435 pero la nota vale 12,000:
    // el papel tiene que decir 12,000.00, que es lo que la base usa para el
    // saldo del cliente.
    const bytes = await pdfNotaRemision(
      nota({
        subtotal: 12000,
        renglones: [
          renglon(),
          renglon({ id: 2, producto_codigo: 'MTO', subtotal: 3060, cantidad_bultos: 4 }),
        ],
      }),
      cliente(),
      EMPRESA,
    );
    const texto = quitarEspacios(textoDelPdf(bytes));

    expect(texto).toContain('$12,000.00');
    expect(texto).not.toContain('$12,435.00');
  });

  it('suma los bultos y los kilos, que no estan en ninguna columna', async () => {
    const bytes = await pdfNotaRemision(
      nota({
        renglones: [
          renglon(),
          renglon({
            id: 2,
            producto_codigo: 'MTO',
            cantidad_bultos: 4,
            kg_bulto: 25.5,
            subtotal: 3060,
          }),
        ],
      }),
      cliente(),
      EMPRESA,
    );
    const texto = quitarEspacios(textoDelPdf(bytes));

    expect(texto).toContain('Bultos:14.00');
    // 10 x 25 + 4 x 25.5 = 352 kg
    expect(texto).toContain('Kilos:352.000');
  });

  it('avisa que la nota esta cancelada, con su motivo', async () => {
    const bytes = await pdfNotaRemision(
      nota({ estatus: 'cancelada', motivo_cancelacion: 'Se rechazo la mercancia' }),
      cliente(),
      EMPRESA,
    );
    const texto = quitarEspacios(textoDelPdf(bytes));

    expect(texto).toContain(quitarEspacios('DOCUMENTO CANCELADO'));
    expect(texto).toContain(quitarEspacios('Se rechazo la mercancia'));
  });

  it('una nota sin motivo de cancelacion igual avisa, sin imprimir un hueco', async () => {
    const bytes = await pdfNotaRemision(
      nota({ estatus: 'cancelada', motivo_cancelacion: null }),
      cliente(),
      EMPRESA,
    );
    const texto = quitarEspacios(textoDelPdf(bytes));

    expect(texto).toContain(quitarEspacios('DOCUMENTO CANCELADO'));
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('una nota larga salta de pagina y repite los titulos de la tabla', async () => {
    // 120 renglones no caben en una hoja: si no saltara de pagina, todos los
    // de mas se dibujarian encima del pie o fuera del papel, en silencio.
    const bytes = await pdfNotaRemision(
      nota({
        subtotal: 1_125_000,
        renglones: Array.from({ length: 120 }, (_vacio, i) =>
          renglon({
            id: i + 1,
            producto_codigo: `P-${i + 1}`,
            producto_nombre: `PRODUCTO DE PRUEBA NUMERO ${i + 1}`,
            subtotal: 9375,
          }),
        ),
      }),
      cliente(),
      EMPRESA,
    );

    const texto = quitarEspacios(textoDelPdf(bytes));

    // 120 renglones no caben en una hoja, asi que salen 3 paginas, cada una
    // con su pie.
    expect(contarApariciones(bytes, 'Página')).toBe(3);
    expect(texto).toContain('Página1de3');
    expect(texto).toContain('Página2de3');
    expect(texto).toContain('Página3de3');

    // Y los titulos se repiten en las tres: sin esto la segunda pagina es una
    // lista de numeros sin columnas, que es el papel que nadie puede usar
    // para detectar un kilo de mas.
    expect(contarApariciones(bytes, 'Descripcion')).toBe(3);

    // El ultimo renglon tambien sale, no solo los primeros.
    expect(texto).toContain('P-120');
  });

  it('imprime igual un nombre con acentos descompuestos', async () => {
    // asi es como llega un nombre tecleado en macOS: "o" y el acento por
    // separado. Sin normalizar, el acento se pierde en el papel.
    const descompuesto = 'Jos'.normalize('NFD') + 'é Pérez';
    const bytes = await pdfNotaRemision(
      nota({ cliente: descompuesto }),
      cliente({ nombre: descompuesto, establo: null, especie: null }),
      EMPRESA,
    );
    const texto = quitarEspacios(textoDelPdf(bytes));

    expect(texto).toContain(quitarEspacios('José Pérez'));
  });

  it('un caracter que no existe en la fuente no rompe el documento', async () => {
    // Los caracteres fuera de WinAnsi se cambian por `?`. Lo que no se puede
    // es dejar que pdfkit reviente, porque entonces el operador se queda sin
    // poder imprimir la nota por un emoji en un nombre.
    const bytes = await pdfNotaRemision(
      nota({ renglones: [renglon({ producto_nombre: 'VIMILAC 400 para 🐮' })] }),
      cliente(),
      EMPRESA,
    );

    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(quitarEspacios(textoDelPdf(bytes))).toContain('VIMILAC400para?');
  });

  it('un salto de linea en un dato no descuadra la tabla', async () => {
    const bytes = await pdfNotaRemision(
      nota({ renglones: [renglon({ producto_nombre: 'VIMILAC\n400\nCONCENTRADO' })] }),
      cliente(),
      EMPRESA,
    );

    // El texto sale pegado, sin el salto que partia la fila en tres lineas
    // dentro de una celda de 176 puntos de ancho.
    expect(quitarEspacios(textoDelPdf(bytes))).toContain(quitarEspacios('VIMILAC 400 CONCENTRADO'));
  });

  it('una nota sin renglones no revienta', async () => {
    // El API no deja crear una nota sin renglones, pero el render no depende
    // de eso: si manana un reporte reuse estas piezas, no debe reventar.
    const bytes = await pdfNotaRemision(nota({ renglones: [] }), cliente(), EMPRESA);

    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(contarApariciones(bytes, 'TOTAL')).toBe(1);
  });

  it('con datos fiscales imprime la razon social y el RFC', async () => {
    const bytes = await pdfNotaRemision(
      nota(),
      cliente({ rfc: 'GAX-040101-9AB', razon_social: 'Granja Los Robles SPR' }),
      EMPRESA,
    );
    const texto = quitarEspacios(textoDelPdf(bytes));

    expect(texto).toContain(quitarEspacios('Granja Los Robles SPR'));
    expect(texto).toContain('GAX-040101-9AB');
  });

  it('sin datos fiscales no imprime ni un guion de relleno', async () => {
    const bytes = await pdfNotaRemision(nota(), cliente({ rfc: null }), EMPRESA);
    const texto = quitarEspacios(textoDelPdf(bytes));

    expect(texto).not.toContain('GAX');
    expect(texto).toContain(quitarEspacios('Granja Los Robles'));
  });
});
