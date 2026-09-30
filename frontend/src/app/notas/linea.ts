import { decimalComoTexto, kilosComoTexto, montoComoTexto, redondearMonto } from '../nucleo/cifras';
import type { Producto, PrecioEfectivo, RenglonNota } from './notas-api';

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
  /**
   * Cuantos bultos hay del producto en el almacen, en el momento en que se
   * consulto. `undefined` cuando no se pudo saber (o cuando la linea viene
   * de una nota que ya se emitio y nadie lo pidio todavia).
   */
  disponible_bultos?: number;
  /**
   * El id del renglon en la base, cuando la linea viene de una nota que se
   * esta corrigiendo.
   *
   * Es lo que le dice al backend "este ya existia": sin el, cada guardado
   * borraria todos los renglones y los volveria a crear, y con ellos sus
   * movimientos de inventario. En el alta no hay ninguno, y por eso es
   * opcional.
   */
  renglon_id?: number;
  /** La bodega de la que salio el producto, si la linea viene de la nota. */
  almacen_id?: number;
  /** El precio que resolved el backend. `null` si todavia no se sabe. */
  precio_unit_kg: number | null;
  /** De donde salio el precio, para poder decirlo en la pantalla. */
  precio_origen: 'cliente' | 'publico' | 'nota' | null;
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

/**
 * Un renglon que ya estaba en la nota, cargado para corregirla.
 *
 * Es la devolucion: la persona abre la nota, baja los bultos de lo que se
 * llevo de mas, quita el renglon de lo que no se llevo, y guarda. El backend
 * mete la diferencia al almacen y recalcula el subtotal.
 *
 * Tres cosas que aqui NO se pueden saber y por eso se resuelven asi:
 *
 *   - El precio no se vuelve a preguntar: se copia el del renglon, que es el
 *     que se cobro. Preguntar el de hoy convertiria una devolucion de 8 bultos
 *     en un cambio de precio por kilo.
 *   - `presentacion_kg` se pone igual al `kg_bulto` que trae la nota. La nota
 *     no guarda la presentacion del producto, solo los kilos que se
 *     cobraron, y este valor solo se usa para saber si la persona VOLVIO a
 *     escribir los kilos; si no los toco, no hay nada que mandar (ver
 *     `kgComoTextoSiHayQueMandarlo`).
 *   - `kg_editado` arranca en `false` aunque el renglon traiga unos kilos que
 *     no son los del producto: los manda el `renglon_id`, no el flag.
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

/** El precio ya resuelto se le pone a la linea. */
export function conPrecio(linea: Linea, precio: PrecioEfectivo): Linea {
  return {
    ...linea,
    precio_unit_kg: precio.precio_kg,
    precio_origen: precio.origen,
  };
}

/**
 * Pone cuantos bultos hay del producto en el almacen.
 *
 * Es un dato de inventario que se consulta aparte del precio: el precio se
 * pregunta para cada producto que se agrega, y lo que hay se pregunta para
 * cada renglon, por eso va como un paso separado (`saberDisponible` en la
 * vista) y no dentro de `agregarProducto`.
 */
export function conDisponible(linea: Linea, disponibles: number): Linea {
  return { ...linea, disponible_bultos: disponibles };
}

/**
 * Lo que queda del producto despues de lo capturado: disponible menos lo
 * que se escribe en los bultos. Es el "se van restando" del mostrador.
 *
 * `null` cuando no se sabe cuantos hay: un renglon sin `disponible_bultos`
 * no puede decir si falta, y la pantalla se calla en vez de inventar.
 */
export function restanteDe(linea: Linea): number | null {
  if (linea.disponible_bultos === undefined) return null;
  return linea.disponible_bultos - linea.cantidad_bultos;
}

/**
 * Que tan chistoso esta el producto: si el precio es de este cliente o el
 * de la lista. El POS lo dice en la linea porque es la pregunta que se
 * hace el operador ("¿le estoy cobrando bien?") y la respuesta son dos
 * palabras.
 *
 * `'nota'` es el caso de una linea que se cargo de una nota para corregirla:
 * el precio no se volvio a preguntar, se tomo del renglon. Decir "precio de
 * lista" ahi seria mentir, porque el de la lista puede ser otro.
 */
export function origenComoTexto(linea: Linea): string {
  if (linea.precio_unit_kg === null) return 'sin precio';
  if (linea.precio_origen === 'cliente') return 'precio de cliente';
  if (linea.precio_origen === 'nota') return 'precio de la nota';
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
 *
 * Los bultos son UNIDADES, no peso: un decimal no se manda. Se trunca a
 * numero entero en lugar de redondear, porque redondear convertiria "3.8"
 * en cuatro bultos de algo que no se cargo entero.
 */
export function cambiarCantidad(linea: Linea, cantidad: number | string): Linea {
  const numero = Math.trunc(Number(cantidad));
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

  // Los bultos son unidades: enteros y positivos. `Number.isInteger` aparte
  // del `> 0`, para que "2.5" no pase como si fueran dos bultos y pico.
  const entero = (numero: number, maximo: number): boolean =>
    Number.isInteger(numero) && numero > 0 && numero <= maximo;

  if (!entero(linea.cantidad_bultos, 99_999_999)) {
    problemas['cantidad_bultos'] =
      'La cantidad debe ser un numero entero positivo (los bultos no llevan decimales)';
  }
  if (!(linea.kg_bulto > 0 && linea.kg_bulto <= 9_999_999)) {
    // Los kilos por bulto SI llevan decimales, asi que no es el `entero` de
    // arriba: solo el mismo `> 0` del `decimal` del backend.
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

/**
 * Los kilos por bulto, pero solo si hay que mandarlos.
 *
 * En el ALTA se mandan solo si la persona los toco: si no, se omiten y la
 * base los rellena con `productos.presentacion_kg`, que es la presentacion
 * real del producto y no la que el navegador recuerda.
 *
 * En la EDICION se mandan siempre, y la razon es el trigger
 * `fn_default_kg_bulto` de 0001: `actualizarRenglon` hace
 * `kg_bulto = COALESCE($4, NULL)`, o sea que un renglon enviado sin kilos
 * vuelve a la presentacion del producto. Una nota que vendio bultos de 25.5
 * kg porque ese dia el producto venia en 25.5 se convertiria sola en bultos
 * de 25, con otros kilos y otro subtotal, por no haber mandado un campo que
 * en pantalla no cambio.
 *
 * Por eso el nombre no dice "si se editaron": la regla es si hay que
 * mandarlos, y depende de si la linea viene de la nota.
 */
export function kgComoTextoSiHayQueMandarlo(linea: Linea): string | null {
  if (linea.renglon_id !== undefined) return decimalComoTexto(linea.kg_bulto, 3);
  if (!linea.kg_editado) return null;
  return decimalComoTexto(linea.kg_bulto, 3);
}
