import { decimalComoTexto, kilosComoTexto, montoComoTexto, redondearMonto } from '../nucleo/cifras';
import type { Producto, PrecioEfectivo } from './notas-api';

/**
 * Un renglon del POS, tal como esta en la pantalla.
 *
 * NO es el renglon que se manda. Este tiene lo que la persona ve y lo que
 * todavia no se sabe (el precio puede no existir todavia); el que se manda lo
 * arma `cuerpoDeNota` en `notas-api.ts`. La razon de que sean dos cosas es
 * que aqui vive el `precio_unit_kg` que el backend prohibio en el alta y el
 * `kg_bulto` que la base rellena, y si se mandara esta misma estructura
 * y el esquema estricto los rechaza con un 400.
 *
 * `uid` es para el `@for` de Angular y para poder tener DOS renglones del
 * mismo producto, que es lo que hace el backend (no los fusiona: suma el
 * consumo para el stock y guarda las filas como van). Ver `agregar`.
 */
export interface Linea {
  uid: number;
  producto_id: number;
  producto_codigo: string;
  producto_nombre: string;
  /** Kilos por bulto que trae el producto. Es el default de la base. */
  presentacion_kg: number;
  /** El que se va a cobrar: el de la presentacion, o el que se escribio. */
  kg_bulto: number;
  /** Que la persona toco los kilos a mano y hay que mandarlos. */
  kg_editado: boolean;
  cantidad_bultos: number;
  /** El precio que resolved el backend. `null` si todavia no se sabe. */
  precio_unit_kg: number | null;
  /** De donde salio el precio, para poder decirlo en la pantalla. */
  precio_origen: 'cliente' | 'publico' | null;
}

/** Un renglon todavia sin precio: sale al mundo cuando el precio llega. */
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

/** El precio ya resuelto se le pone a la linea. */
export function conPrecio(linea: Linea, precio: PrecioEfectivo): Linea {
  return {
    ...linea,
    precio_unit_kg: precio.precio_kg,
    precio_origen: precio.origen,
  };
}

/**
 * Que tan chistoso esta el producto: si el precio es de este cliente o el
 * de la lista. El POS lo dice en la linea porque es la pregunta que se
 * hace el operador ("¿le estoy cobrando bien?") y la respuesta son dos
 * palabras.
 */
export function origenComoTexto(linea: Linea): string {
  if (linea.precio_unit_kg === null) return 'sin precio';
  if (linea.precio_origen === 'cliente') return 'precio de cliente';
  return 'precio de lista';
}

/** Un renglon con precio y con cantidad: lo que se puede cobrar. */
export function totalDeLinea(linea: Linea): number {
  if (linea.precio_unit_kg === null) return 0;
  return redondearMonto(linea.cantidad_bultos * linea.kg_bulto * linea.precio_unit_kg);
}

/**
 * El total de la nota en pantalla.
 *
 * Es un PREVISUALIZADO, no el monto del documento. La suma se hace aqui
 * porque el operador lo necesita mientras captura, y el redondeo es el del
 * double (ver `redondearMonto`): puede haber una diferencia de un centavo
 * contra el `subtotal` que calcula Postgres al guardar. Cuando se guarda,
 * en la pantalla manda el del servidor y este se sustituye por el.
 */
export function totalDeLineas(lineas: Linea[]): number {
  return redondearMonto(lineas.reduce((suma, linea) => suma + totalDeLinea(linea), 0));
}

/** Kilos de la nota, que es lo que se entrega y lo que se descuenta del almacen. */
export function kilosDeLineas(lineas: Linea[]): number {
  return lineas.reduce((suma, linea) => suma + linea.cantidad_bultos * linea.kg_bulto, 0);
}

/**
 * Cantidad de kilos de una linea, con los tres decimales que usan los
 * kilos por bulto.
 */
export function kilosDeLinea(linea: Linea): string {
  return kilosComoTexto(linea.cantidad_bultos * linea.kg_bulto);
}

/** El total de la linea, en dinero. */
export function montoDeLinea(linea: Linea): string {
  return montoComoTexto(totalDeLinea(linea));
}

/**
 * Cambia la cantidad de bultos.
 *
 * `cero` se vuelve a uno y no a cero: `cantidad_bultos` es un `decimal(...,
 * ..., 'cantidad_bultos')` en el backend, que REJAZA el cero con un 422
 * ("no puede ser cero ni negativo"), y una linea en cero es una linea que
 * no se puede cobrar ni borrar sin buscarla. Volver a uno deja la nota en
 * un estado que si se puede mandar.
 */
export function cambiarCantidad(linea: Linea, cantidad: number | string): Linea {
  const numero = Number(cantidad);
  // Lo que no se puede leer se IGNORA y no se convierte en uno. La distincion
  // es con el cero, que si es un numero valido que el backend no acepta; un
  // "abc" a medio teclear no es un cero, y pisar la cantidad que habia con
  // un uno porque el campo quedo a medias es perder trabajo de la persona.
  if (!Number.isFinite(numero)) return linea;
  return { ...linea, cantidad_bultos: numero > 0 ? numero : 1 };
}

/**
 * Cambia los kilos por bulto a mano.
 *
 * El cero y el negativo NO se aceptan, y devuelven la linea como estaba con
 * la presentacion del producto. No es capricho: `kg_bulto` es un
 * `decimal(7, 3, 'kg_bulto')` del backend, que exige `Number(valor) > 0`, y
 * un cero llega como un 422 de "no puede ser cero ni negativo" DESPUES de
 * que la persona capturo la nota entera.
 *
 * La tentacion de dejar pasar el cero es que "el banano se vende por
 * unidades, no por kilos". El modelo no tiene esa idea: `presentacion_kg`
 * es "kg por bulto" y es NOT NULL, asi que un producto por pieza se
 * representa con un bulto de 1 kg, no con un bulto de 0. Si algun dia se
 * venden piezas de verdad, el cambio es una columna mas en `productos` y
 * una regla mas en el renglon, no un cero escondido aqui.
 */
export function cambiarKilos(linea: Linea, kilos: number | string): Linea {
  const numero = Number(kilos);
  if (!Number.isFinite(numero) || numero <= 0) return linea;
  return { ...linea, kg_bulto: numero, kg_editado: numero !== linea.presentacion_kg };
}

/**
 * Agrega un producto a la nota.
 *
 * Si ya estaba, SUMA la cantidad en vez de abrir otra fila. Dos razones, y
 * las dos importan:
 *
 *   - El operador no va a buscar si ya lo habia puesto. En un mostrador se
 *     agrega el mismo producto dos veces cuando se le olvidó, y la nota con
 *     dos renglones del mismo producto se ve como un error.
 *   - El backend SÍ LOS SUMA para el stock (`prepararRenglones` lleva un
 *     `consumo` por producto-almacen) pero guarda las dos filas. O sea que
 *     las dos formas dan el mismo resultado en la base, y la de la
 *     pantalla es mas legible.
 *
 * `uid` es un contador de modulo, no un `Math.random`: dos renglones con el
 *     mismo producto necesitan identificadores distintos y el aleatorio
 *     hace que un @for de Angular se queje de claves duplicadas cuando
 *     casualmente se repiten.
 */
let ultimoUid = 0;

function siguienteUid(): number {
  ultimoUid += 1;
  return ultimoUid;
}

/** Agregar, fusionando con la linea existente del mismo producto. */
export function agregar(lineas: Linea[], linea: Linea): Linea[] {
  const misma = lineas.find((otra) => otra.producto_id === linea.producto_id);
  if (!misma) return [...lineas, linea];
  return lineas.map((otra) =>
    otra.producto_id === linea.producto_id
      ? { ...otra, cantidad_bultos: otra.cantidad_bultos + linea.cantidad_bultos }
      : otra,
  );
}

/** Quita el renglon. Por `uid`, no por producto: hay una fila por uid. */
export function quitar(lineas: Linea[], uid: number): Linea[] {
  return lineas.filter((linea) => linea.uid !== uid);
}

/** Vacia la nota, menos el cliente: el mismo cliente, otra venta. */
export function vaciar(lineas: Linea[]): Linea[] {
  return lineas.length > 0 ? [] : lineas;
}

/**
 * Que problemas tiene un renglon, para ENCENDER los campos en vez de
 * dejar que la persona mande algo que el backend va a rechazar.
 *
 * Las reglas son un espejo de `renglonNotaEsquema`: los limites de
 * decimales y de cifras enteras son los mismos, porque el backend los
 * revalida y un 422 de esos llega como un error de validacion de un campo
 * que en la pantalla no existe todavia.
 */
export function problemasDe(linea: Linea): Record<string, string> {
  const problemas: Record<string, string> = {};

  const entero = (numero: number, maximo: number): boolean =>
    Math.floor(numero) > 0 && numero <= maximo;

  if (!entero(linea.cantidad_bultos, 99_999_999)) {
    problemas['cantidad_bultos'] = 'La cantidad debe ser un numero positivo';
  }
  if (!entero(linea.kg_bulto, 9_999_999)) {
    // El mismo `> 0` del `decimal` del backend, y por el mismo motivo.
    problemas['kg_bulto'] = 'Los kilos por bulto tienen que ser mas de cero';
  }
  if (linea.precio_unit_kg === null) {
    problemas['precio_unit_kg'] = 'Este producto no tiene precio vigente';
  }

  return problemas;
}

/** Si el renglon se puede mandar tal cual. */
export function lineaValida(linea: Linea): boolean {
  return Object.keys(problemasDe(linea)).length === 0;
}

/**
 * La forma del `cantidad_bultos` que va en el JSON.
 *
 * Se manda como TEXTO, no como numero, a proposito: el backend lo acepta
 * en las dos formas y lo convierte a texto antes de validarlo (ver el
 * `decimal` de `notas-remision/esquemas.ts`), porque el double de
 * JavaScript no sirve para dinero ni para cantidades. Mandar el texto
 * "8.5" y no el 8.5 quita de en medio el unico punto donde un 0.1 + 0.2
 * pueda colarse.
 */
export function cantidadComoTexto(linea: Linea): string {
  return decimalComoTexto(linea.cantidad_bultos, 2);
}

/** Los kilos por bulto, si la persona los toco. Si no, no se mandan. */
export function kilosComoTextoSiEditados(linea: Linea): string | null {
  if (!linea.kg_editado) return null;
  return decimalComoTexto(linea.kg_bulto, 3);
}
