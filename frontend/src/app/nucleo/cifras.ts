/**
 * Números: cómo se muestran y cómo se mandan.
 *
 * Es el espejo de `core/valores.ts` del sistema. No se reimplementa nada de la
 * lógica de negocio, pero las DOS mitades de una cantidad sí tienen que estar
 * escritas con la misma regla, porque si no aparece el caso clásico: el sistema
 * acepta `8.50` y devuelve `8.5`, la pantalla muestra `8.50`, y al compararlos
 * para ver si la nota cambió aparece que SÍ cambió.
 *
 * Hay dos familias y no se mezclan:
 *
 *   - `numeroComoTexto` y sus dos atajos, para MOSTRAR.
 *   - `decimalComoTexto`, para MANDAR en los datos de una petición.
 *
 * Y una regla que atraviesa las dos, y que viene del sistema: los números con
 * decimales de JavaScript no sirven para calcular dinero. Un `NUMERIC(12,2)` de
 * la base sale del sistema como texto y se convierte a `number` solo para
 * pintarlo; cualquier multiplicación de estos números es una estimación para el
 * operador, nunca el monto del documento. El que vale es el `subtotal` que
 * devuelve la nota guardada, y así se trata en el punto de venta.
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
 * Un número como se escribe en un documento de remisión en México: coma para
 * los miles, punto para los decimales.
 *
 * El separador de miles es la coma y el decimal el punto porque es como se
 * escribe una cantidad en un papel. Al revés se entiende el papel y no la
 * pantalla, que ya está en español.
 *
 * `Number.isFinite` y no un `if (valor)` suelto: `NaN` e `Infinity` se imprimen
 * como «NaN» e «Infinity» con un separador de miles en medio.
 */
export function numeroComoTexto(valor: number, decimales: number): string {
  if (!Number.isFinite(valor)) return '0';

  const signo = valor < 0 ? '-' : '';
  // `toFixed` siempre devuelve un punto, pero el tipo lo ve como opcional: se
  // comprueba en vez de asumirlo.
  const [enteros = '0', decimalesTexto] = Math.abs(valor).toFixed(decimales).split('.');
  const conMiles = enteros.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return decimalesTexto === undefined
    ? `${signo}${conMiles}`
    : `${signo}${conMiles}.${decimalesTexto}`;
}

/**
 * Un número como lo MANDA la aplicación: punto decimal, sin separador de miles
 * y sin ceros de más.
 *
 * La razón de normalizar en vez de mandar el texto que se tecleó es que el
 * sistema valida con una expresión regular (`^\d{1,8}(\.\d{1,2})?$`) y «8,50»,
 * «8.50 », «+8.5» y «8.500» se rechazan con un 400. Un campo de número entrega
 * el valor ya convertido, pero entre el campo y los datos que se mandan hay un
 * rato en el que el texto puede llevar espacios, y no vale que la pantalla falle
 * por eso.
 *
 * `String(Number(...))` y no `toFixed`: `toFixed` siempre añade los decimales
 * pedidos, y «8.00 bultos» metido en los datos es ruido. Para mostrar la
 * cantidad sí se quiere ver «8.00», que es cosa de la pantalla.
 */
export function decimalComoTexto(valor: number | string, decimales: number): string {
  if (typeof valor === 'string' && valor.trim() === '') {
    // `Number('')` es 0, no NaN: un campo vacío se volvería «0» y «0» es un
    // número válido para la expresión del sistema, que lo rechaza después con
    // un 422 de «no puede ser cero». Aquí se truena antes, y con un mensaje que
    // dice qué pasó.
    throw new Error('no se puede mandar una cantidad vacia');
  }
  const numero = typeof valor === 'number' ? valor : Number(String(valor).trim().replace(',', '.'));
  if (!Number.isFinite(numero)) {
    throw new Error(`"${String(valor)}" no es un numero`);
  }
  // Se redondea ANTES de convertir a texto: sin esto, 0.1 + 0.2 sería
  // «0.30000000000000004» y el sistema lo rechaza por tener demasiados
  // decimales. Aquí todavía no se sabe si el número es dinero, así que el
  // redondeo es al número de decimales que se pidió, no a dos.
  const redondeado = Number(numero.toFixed(decimales));
  return String(redondeado);
}

/**
 * Redondeo a dos decimales, que es la precisión de los `NUMERIC(12,2)`.
 *
 * Math.round y no el redondeo «de banquero» porque es el que usa la base en un
 * NUMERIC y los dos tienen que dar el mismo número: si la pantalla dice 1,005 y
 * el documento dice 1,00, el operador deja de fiarse de la pantalla, y con
 * razón.
 *
 * Elige Math.round y no una suma de epsilon a propósito. Sobre el número
 * binario el empate exacto (.5) no existe casi nunca, así que sumar 0.0000001
 * «para arreglarlo» sería mover dinero en la mayoría de los casos y movería de
 * verdad los casos que están cerca del redondeo. La vista previa es una vista
 * previa; el monto que vale es el del sistema.
 */
export function redondearMonto(valor: number): number {
  if (!Number.isFinite(valor)) return 0;
  return Math.round(valor * 100) / 100;
}
