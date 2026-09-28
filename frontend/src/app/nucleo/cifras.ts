/**
 * Numeros: como se muestran y como se mandan.
 *
 * Es el espejo de `core/valores.ts` del backend. No se reimplementa nada de
 * la logica de negocio, pero las DOS mitades de una cantidad si tienen que
 * estar escritas con la misma regla, porque si no aparece el caso clasico:
 * el backend acepta `8.50` y devuelve `8.5`, la pantalla muestra `8.50`, y
 * al compararlos para ver si la nota cambio aparece que SI cambio.
 *
 * Hay dos familias y no se mezclan:
 *
 *   - `numeroComoTexto` y sus dos atajos, para MOSTRAR.
 *   - `decimalComoTexto`, para MANDAR en el cuerpo de una peticion.
 *
 * Y una regla que atraviesa las dos, y que viene del backend: el double de
 * JavaScript no sirve para calcular dinero. Un `NUMERIC(12,2)` de Postgres
 * sale del servidor como texto y se convierte a `number` solo para
 * pintarlo; cualquier multiplicacion de estos numeros es una estimacion
 * para el operador, nunca el monto del documento. El que vale es el
 * `subtotal` que devuelve la nota guardada, y asi se trata en el POS.
 */

/** Un `NUMERIC(12,2)` de la base siempre se ve con dos decimales. */
export function montoComoTexto(valor: number): string {
  return numeroComoTexto(valor, 2);
}

/** Bultos: dos decimales, como `cantidad_bultos` (NUMERIC(10,2)). */
export function bultosComoTexto(valor: number): string {
  return numeroComoTexto(valor, 2);
}

/** Cantidades de producto: bultos a 2 decimales, kilos a 3. Ver `kg_bulto`. */
export function kilosComoTexto(valor: number): string {
  return numeroComoTexto(valor, 3);
}

/**
 * Un numero como se escribe en un documento de remision en Mexico:
 * coma para los miles, punto para los decimales.
 *
 * El separador de miles es la coma y el decimal el punto porque es como se
 * escribe una cantidad en un papel. Al revés se entiende el papel y no la
 * pantalla, que ya esta en espanol.
 *
 * `Number.isFinite` y no un `if (valor)` suelto: `NaN` e `Infinity` se
 * imprimen como "NaN" y "Infinity" con un separador de miles en medio.
 */
export function numeroComoTexto(valor: number, decimales: number): string {
  if (!Number.isFinite(valor)) return '0';

  const signo = valor < 0 ? '-' : '';
  // `toFixed` siempre devuelve un punto, pero el tipo lo ve como opcional:
  // se comprueba en vez de asumirlo.
  const [enteros = '0', decimalesTexto] = Math.abs(valor).toFixed(decimales).split('.');
  const conMiles = enteros.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return decimalesTexto === undefined
    ? `${signo}${conMiles}`
    : `${signo}${conMiles}.${decimalesTexto}`;
}

/**
 * Un numero como lo Manda la app: punto decimal, sin separador de miles y
 * sin ceros de mas.
 *
 * La razon de normalizing en vez de mandar el texto que se tecleo es que el
 * backend valida con una expresion regular (`^\d{1,8}(\.\d{1,2})?$`) y
 * "8,50", "8.50 ", "+8.5" y "8.500" se rechazan con un 400. Un `input` de
 * numero entrega el valor ya parseado, pero entre el `input` y el JSON hay
 * un rato en el que el texto puede llevar espacios, y no vale que la
 * pantalla falle por eso.
 *
 * `String(Number(...))` y no `toFixed`: `toFixed` siempre anade los
 * decimales pedidos, y "8.00 bultos" spendido en el cuerpo es ruido. Para
 * notificar cantidad si se quiere ver "8.00", que es cosa de la pantalla.
 */
export function decimalComoTexto(valor: number | string, decimales: number): string {
  if (typeof valor === 'string' && valor.trim() === '') {
    // `Number('')` es 0, no NaN: un campo vacio se volveria "0" y "0" es un
    // numero valido para la expresion del backend, que lo rechaza despues
    // con un 422 de "no puede ser cero". Aqui se truena antes, y con un
    // mensaje que dice que paso.
    throw new Error('no se puede mandar una cantidad vacia');
  }
  const numero = typeof valor === 'number' ? valor : Number(String(valor).trim().replace(',', '.'));
  if (!Number.isFinite(numero)) {
    throw new Error(`"${String(valor)}" no es un numero`);
  }
  // Se redondea ANTES de convertir a texto: sin esto, 0.1 + 0.2 seria
  // "0.30000000000000004" y el backend lo rechaza por tener demasiados
  // decimales. Aqui todavia no se sabe si el numero es dinero, asi que el
  // redondeo es al numero de decimales que se pidio, no a dos.
  const redondeado = Number(numero.toFixed(decimales));
  return String(redondeado);
}

/**
 * Redondeo a dos decimales, que es la precision de los `NUMERIC(12,2)`.
 *
 * Math.round y no el redondeo "de banker" porque es el que usa Postgres en
 * un NUMERIC y los dos tienen que dar el mismo numero: si la pantalla dice
 * 1,005 y el documento dice 1,00, el operador deja de fiarse de la
 * pantalla, y con razon.
 *
 * Elije Math.round y no una suma de epsilon a proposito. Sobre el double
 * binario el empate exacto (.5) no existe casi nunca, asi que sumar
 * 0.0000001 "para arreglarlo" seria mover dinero en la mayoria de los casos y
 * moveria de verdad los casos que estan cerca del redondeo. El preview es
 * un preview; el monto que vale es el del servidor.
 */
export function redondearMonto(valor: number): number {
  if (!Number.isFinite(valor)) return 0;
  return Math.round(valor * 100) / 100;
}
