import { decimalComoTexto, kilosComoTexto, montoComoTexto, redondearMonto } from '../nucleo/cifras';
import type { Producto, PrecioEfectivo, RenglonNota } from './notas-api';

/**
 * Un renglón de la nota, tal como se ve en la pantalla.
 *
 * NO es el renglón que se manda al guardar. Este tiene lo que la persona ve y
 * lo que todavía no se sabe (el precio puede no existir todavía); el que se
 * manda lo arma `cuerpoDeNota` en `notas-api.ts`. Son dos cosas distintas
 * porque aquí vive el `precio_unit_kg`, que el sistema no acepta al crear la
 * nota, y el `kg_bulto` que el mismo sistema rellena, y si se mandara esta
 * misma estructura la validación la rechazaría.
 *
 * `uid` es para el `@for` de Angular y para poder tener DOS renglones del
 * mismo producto, que es lo que hace el sistema (no los junta: suma el
 * consumo para el inventario y guarda las filas como van). Ver `agregar`.
 */
export interface Linea {
  uid: number;
  producto_id: number;
  producto_codigo: string;
  producto_nombre: string;
  /** Kilos por bulto que trae el producto. Es el valor normal del sistema. */
  presentacion_kg: number;
  /** El que se va a cobrar: el de la presentación, o el que se escribió. */
  kg_bulto: number;
  /** Que la persona tocó los kilos a mano y hay que mandarlos. */
  kg_editado: boolean;
  cantidad_bultos: number;
  /**
   * Cuántos bultos hay del producto en el almacén, en el momento en que se
   * consultó. `undefined` cuando no se pudo saber (o cuando el renglón viene
   * de una nota que ya se emitió y nadie lo pidió todavía).
   */
  disponible_bultos?: number;
  /**
   * El id del renglón en el sistema, cuando el renglón viene de una nota que
   * se está corrigiendo.
   *
   * Es lo que le dice al sistema "este ya existía": sin él, cada guardado
   * borraría todos los renglones y los volvería a crear, y con ellos sus
   * movimientos de inventario. Al crear una nota no hay ninguno, y por eso es
   * opcional.
   */
  renglon_id?: number;
  /** La bodega de la que salió el producto, si el renglón viene de la nota. */
  almacen_id?: number;
  /** El precio que resolvió el sistema. `null` si todavía no se sabe. */
  precio_unit_kg: number | null;
  /** De dónde salió el precio, para poder decirlo en la pantalla. */
  precio_origen: 'cliente' | 'publico' | 'nota' | null;
}

/** Un renglón todavía sin precio: aparece en cuanto el precio llega. */
export function lineaVacia(producto: Producto): Linea {
  return {
    uid: siguienteUid(),
    producto_id: producto.id,
    producto_codigo: producto.codigo,
    producto_nombre: producto.nombre,
    presentacion_kg: producto.presentacion_kg,
    kg_bulto: producto.presentacion_kg,
    kg_editado: false,
    cantidad_bultos: 1,
    precio_unit_kg: null,
    precio_origen: null,
  };
}

/**
 * Un renglón que ya estaba en la nota, cargado para corregirla.
 *
 * Es la devolución: la persona abre la nota, baja los bultos de lo que se
 * llevó de más, quita el renglón de lo que no se llevó, y guarda. El sistema
 * mete la diferencia al almacén y recalcula el total.
 *
 * Tres cosas que aquí NO se pueden saber y por eso se resuelven así:
 *
 *   - El precio no se vuelve a preguntar: se copia el del renglón, que es el
 *     que se cobró. Preguntar el de hoy convertiría una devolución de 8 bultos
 *     en un cambio de precio por kilo.
 *   - `presentacion_kg` se pone igual al `kg_bulto` que trae la nota. La nota
 *     no guarda la presentación del producto, solo los kilos que se cobraron,
 *     y este valor solo se usa para saber si la persona VOLVIÓ a escribir los
 *     kilos; si no los tocó, no hay nada que mandar (ver
 *     `kgComoTextoSiHayQueMandarlo`).
 *   - `kg_editado` arranca en `false` aunque el renglón traiga unos kilos que
 *     no son los del producto: los manda el `renglon_id`, no la marca.
 */
export function lineaDeRenglon(renglon: RenglonNota): Linea {
  return {
    uid: siguienteUid(),
    producto_id: renglon.producto_id,
    producto_codigo: renglon.producto_codigo,
    producto_nombre: renglon.producto_nombre,
    presentacion_kg: renglon.kg_bulto,
    kg_bulto: renglon.kg_bulto,
    kg_editado: false,
    cantidad_bultos: renglon.cantidad_bultos,
    renglon_id: renglon.id,
    almacen_id: renglon.almacen_id,
    precio_unit_kg: renglon.precio_unit_kg,
    precio_origen: 'nota',
  };
}

/** Al renglón se le pone el precio ya resuelto. */
export function conPrecio(linea: Linea, precio: PrecioEfectivo): Linea {
  return {
    ...linea,
    precio_unit_kg: precio.precio_kg,
    precio_origen: precio.origen,
  };
}

/**
 * Pone cuántos bultos hay del producto en el almacén.
 *
 * Es un dato de inventario que se consulta aparte del precio: el precio se
 * pregunta para cada producto que se agrega, y lo que hay se pregunta para
 * cada renglón, por eso va como un paso separado (`saberDisponible` en la
 * vista) y no dentro de `agregarProducto`.
 */
export function conDisponible(linea: Linea, disponibles: number): Linea {
  return { ...linea, disponible_bultos: disponibles };
}

/**
 * Lo que queda del producto después de lo capturado: lo disponible menos lo
 * que se escribe en los bultos. Es el "se van restando" del mostrador.
 *
 * `null` cuando no se sabe cuántos hay: un renglón sin `disponible_bultos`
 * no puede decir si falta, y la pantalla se calla en vez de inventar.
 */
export function restanteDe(linea: Linea): number | null {
  if (linea.disponible_bultos === undefined) return null;
  return linea.disponible_bultos - linea.cantidad_bultos;
}

/**
 * De dónde salió el precio: si es del cliente o de la lista. La pantalla lo
 * dice en el renglón porque es la pregunta que se hace el operador ("¿le
 * estoy cobrando bien?") y la respuesta son dos palabras.
 *
 * `'nota'` es el caso de un renglón que se cargó de una nota para corregirla:
 * el precio no se volvió a preguntar, se tomó del renglón. Decir "precio de
 * lista" ahí sería mentir, porque el de la lista puede ser otro.
 */
export function origenComoTexto(linea: Linea): string {
  if (linea.precio_unit_kg === null) return 'sin precio';
  if (linea.precio_origen === 'cliente') return 'precio de cliente';
  if (linea.precio_origen === 'nota') return 'precio de la nota';
  return 'precio de lista';
}

/** Un renglón con precio y con cantidad: lo que se puede cobrar. */
export function totalDeLinea(linea: Linea): number {
  if (linea.precio_unit_kg === null) return 0;
  return redondearMonto(linea.cantidad_bultos * linea.kg_bulto * linea.precio_unit_kg);
}

/**
 * El total de la nota en pantalla.
 *
 * Es un ADELANTO, no el monto del documento. La suma se hace aquí porque el
 * operador lo necesita mientras captura, y el redondeo es el normal (ver
 * `redondearMonto`): puede haber una diferencia de un centavo contra el total
 * que calcula el sistema al guardar. Cuando se guarda, en pantalla manda el
 * del sistema y este se sustituye por él.
 */
export function totalDeLineas(lineas: Linea[]): number {
  return redondearMonto(lineas.reduce((suma, linea) => suma + totalDeLinea(linea), 0));
}

/** Kilos de la nota, que es lo que se entrega y lo que se descuenta del almacén. */
export function kilosDeLineas(lineas: Linea[]): number {
  return lineas.reduce((suma, linea) => suma + linea.cantidad_bultos * linea.kg_bulto, 0);
}

/**
 * Cantidad de kilos de un renglón, con los tres decimales que usan los kilos
 * por bulto.
 */
export function kilosDeLinea(linea: Linea): string {
  return kilosComoTexto(linea.cantidad_bultos * linea.kg_bulto);
}

/** El total del renglón, en dinero. */
export function montoDeLinea(linea: Linea): string {
  return montoComoTexto(totalDeLinea(linea));
}

/**
 * Cambia la cantidad de bultos.
 *
 * `cero` se vuelve a uno y no a cero: la cantidad de bultos es un dato que el
 * sistema RECHAZA si es cero o negativo, y un renglón en cero no se puede
 * cobrar ni borrar sin buscarlo. Volver a uno deja la nota en un estado que
 * sí se puede mandar.
 *
 * Los bultos son UNIDADES, no peso: no se manda un decimal. Se corta a número
 * entero en lugar de redondear, porque redondear convertiría "3.8" en cuatro
 * bultos de algo que no se cargó entero.
 */
export function cambiarCantidad(linea: Linea, cantidad: number | string): Linea {
  const numero = Math.trunc(Number(cantidad));
  // Lo que no se puede leer se IGNORA y no se convierte en uno. La distinción
  // es con el cero, que sí es un número válido pero que el sistema rechaza; un
  // "abc" a medio teclear no es un cero, y pisar la cantidad que había con
  // un uno porque el campo quedó a medias es perder trabajo de la persona.
  if (!Number.isFinite(numero)) return linea;
  return { ...linea, cantidad_bultos: numero > 0 ? numero : 1 };
}

/**
 * Cambia los kilos por bulto a mano.
 *
 * El cero y el negativo NO se aceptan, y dejan el renglón como estaba con la
 * presentación del producto. No es capricho: el sistema exige que los kilos
 * por bulto sean mayores que cero, y un cero se convierte en un rechazo
 * DESPUÉS de que la persona capturó la nota entera.
 *
 * La tentación de dejar pasar el cero es que "el banano se vende por
 * unidades, no por kilos". El sistema no tiene esa idea: los kilos por bulto
 * son obligatorios, así que un producto por pieza se representa con un bulto
 * de 1 kg, no con un bulto de 0. Si algún día se venden piezas de verdad, el
 * cambio es un dato más en el catálogo de productos y una regla más en el
 * renglón, no un cero escondido aquí.
 */
export function cambiarKilos(linea: Linea, kilos: number | string): Linea {
  const numero = Number(kilos);
  if (!Number.isFinite(numero) || numero <= 0) return linea;
  return { ...linea, kg_bulto: numero, kg_editado: numero !== linea.presentacion_kg };
}

/**
 * Agrega un producto a la nota.
 *
 * Si ya estaba, SUMA la cantidad en vez de abrir otro renglón. Dos razones, y
 * las dos importan:
 *
 *   - El operador no va a buscar si ya lo había puesto. En un mostrador se
 *     agrega el mismo producto dos veces cuando se le olvidó, y la nota con
 *     dos renglones del mismo producto se ve como un error.
 *   - El sistema SÍ LOS SUMA para el inventario (lleva un consumo por
 *     producto y almacén) pero guarda los dos renglones. O sea que las dos
 *     formas dan el mismo resultado, y la de la pantalla es más legible.
 *
 * `uid` es un contador del archivo, no un número al azar: dos renglones con
 * el mismo producto necesitan identificadores distintos y el azar hace que un
 * @for de Angular se queje de claves duplicadas cuando casualmente se repiten.
 */
let ultimoUid = 0;

function siguienteUid(): number {
  ultimoUid += 1;
  return ultimoUid;
}

/** Agregar, juntando con el renglón que ya existe del mismo producto. */
export function agregar(lineas: Linea[], linea: Linea): Linea[] {
  const misma = lineas.find((otra) => otra.producto_id === linea.producto_id);
  if (!misma) return [...lineas, linea];
  return lineas.map((otra) =>
    otra.producto_id === linea.producto_id
      ? { ...otra, cantidad_bultos: otra.cantidad_bultos + linea.cantidad_bultos }
      : otra,
  );
}

/** Quita el renglón. Por `uid`, no por producto: hay un renglón por uid. */
export function quitar(lineas: Linea[], uid: number): Linea[] {
  return lineas.filter((linea) => linea.uid !== uid);
}

/** Vacía la nota, menos el cliente: el mismo cliente, otra venta. */
export function vaciar(lineas: Linea[]): Linea[] {
  return lineas.length > 0 ? [] : lineas;
}

/**
 * Qué problemas tiene un renglón, para ENCENDER los campos en vez de dejar
 * que la persona mande algo que el sistema va a rechazar.
 *
 * Las reglas son las mismas que valida el sistema al guardar: los límites de
 * decimales y de cifras enteras son idénticos, porque el sistema los vuelve a
 * revisar y un rechazo de esos llega como un aviso de un campo que en la
 * pantalla todavía no existe.
 */
export function problemasDe(linea: Linea): Record<string, string> {
  const problemas: Record<string, string> = {};

  // Los bultos son unidades: enteros y positivos. Se revisa que sea entero
  // aparte de que sea mayor que cero, para que "2.5" no pase como si fueran
  // dos bultos y pico.
  const entero = (numero: number, maximo: number): boolean =>
    Number.isInteger(numero) && numero > 0 && numero <= maximo;

  if (!entero(linea.cantidad_bultos, 99_999_999)) {
    problemas['cantidad_bultos'] =
      'La cantidad debe ser un número entero positivo (los bultos no llevan decimales)';
  }
  if (!(linea.kg_bulto > 0 && linea.kg_bulto <= 9_999_999)) {
    // Los kilos por bulto SÍ llevan decimales, así que no es el `entero` de
    // arriba: solo la misma regla de que sean mayores que cero.
    problemas['kg_bulto'] = 'Los kilos por bulto tienen que ser más de cero';
  }
  if (linea.precio_unit_kg === null) {
    problemas['precio_unit_kg'] = 'Este producto no tiene precio vigente';
  }

  return problemas;
}

/** Si el renglón se puede mandar tal cual. */
export function lineaValida(linea: Linea): boolean {
  return Object.keys(problemasDe(linea)).length === 0;
}

/**
 * La forma de la cantidad de bultos que se manda al guardar.
 *
 * Se manda como TEXTO, no como número, a propósito: el sistema la acepta en
 * las dos formas y la convierte a texto antes de validarla (ver
 * `notas-remision/esquemas.ts`), porque los decimales de JavaScript no son
 * confiables ni para dinero ni para cantidades. Mandar el texto "8.5" y no el
 * 8.5 quita de en medio el único punto donde un 0.1 + 0.2 pueda colarse.
 */
export function cantidadComoTexto(linea: Linea): string {
  return decimalComoTexto(linea.cantidad_bultos, 2);
}

/**
 * Los kilos por bulto, pero solo si hay que mandarlos.
 *
 * Al CREAR la nota se mandan solo si la persona los tocó: si no, se omiten y
 * el sistema los rellena con la presentación real del producto, que es la del
 * catálogo y no la que el navegador recuerda.
 *
 * Al CORREGIR se mandan siempre, y la razón es la regla automática del
 * sistema que rellena los kilos: un renglón enviado sin kilos vuelve a la
 * presentación del producto. Una nota que vendió bultos de 25.5 kg porque ese
 * día el producto venía en 25.5 se convertiría sola en bultos de 25, con
 * otros kilos y otro total, por no haber mandado un dato que en pantalla no
 * cambió.
 *
 * Por eso el nombre no dice "si se editaron": la regla es si hay que
 * mandarlos, y depende de si el renglón viene de la nota.
 */
export function kgComoTextoSiHayQueMandarlo(linea: Linea): string | null {
  if (linea.renglon_id !== undefined) return decimalComoTexto(linea.kg_bulto, 3);
  if (!linea.kg_editado) return null;
  return decimalComoTexto(linea.kg_bulto, 3);
}
