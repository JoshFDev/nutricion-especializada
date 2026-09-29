import { decimalComoTexto, kilosComoTexto, montoComoTexto, redondearMonto } from '../nucleo/cifras';
import type { ProductoOpcion } from './compras-api';

/**
 * Un renglon de compra, tal como esta en la pantalla.
 *
 * NO es el renglon que se manda. Este tiene lo que la persona ve y los dos
 * datos que el backend sabe rellenar: el `kg_bulto` (que sale de
 * `productos.presentacion_kg` con `fn_default_kg_bulto`) y el `precio_kg`
 * (que sale del ultimo costo del proveedor). El que se manda lo arma
 * `cuerpoDeCompra` en `compras-api.ts`, y manda esos dos SOLO si la persona
 * los toco.
 *
 * La diferencia de fondo con el renglon del POS (`notas/linea.ts`) es que
 * aqui el precio PUEDE no conocerse: en una compra el costo no esta en la
 * pantalla —vive en `producto_proveedor_precios`, y no hay endpoint que lo
 * exponga—, asi que `precio_kg: null` significa "que lo resuelva el sistema",
 * no "falta un dato". Por eso el total de la compra es un preview que puede
 * dejar renglones fuera (ver `totalDeLineas`).
 *
 * `uid` es para el `@for` de Angular. A diferencia del POS, agregar el mismo
 * producto DOS veces NO se fusiona: un proveedor puede vender el mismo
 * producto en dos lotes a distinto costo, y el backend guarda las dos filas
 * (`prepararRenglones` no suma; no es una venta). Fusionarlas perderia uno de
 * los dos costos.
 */
export interface LineaCompra {
  uid: number;
  producto_id: number;
  producto_codigo: string;
  producto_nombre: string;
  /** Kilos por bulto del producto. Es el default de la base. */
  presentacion_kg: number;
  cantidad_bultos: number;
  /** El que se va a guardar: el de la presentacion, o el que se escribio. */
  kg_bulto: number;
  /** Que la persona toco los kilos a mano y hay que mandarlos. */
  kg_editado: boolean;
  /**
   * El costo por kilo escrito a mano, o `null` para que lo resuelva el
   * backend con el ultimo costo de ESE proveedor. `0` es un precio valido
   * (una cortesia), distinto de `null` (no lo escribi).
   */
  precio_kg: number | null;
}

let ultimoUid = 0;

function siguienteUid(): number {
  ultimoUid += 1;
  return ultimoUid;
}

/** Un renglon recien agregado: un bulto, con el kg del producto y sin costo. */
export function lineaVacia(producto: ProductoOpcion): LineaCompra {
  return {
    uid: siguienteUid(),
    producto_id: producto.id,
    producto_codigo: producto.codigo,
    producto_nombre: producto.nombre,
    presentacion_kg: producto.presentacion_kg,
    cantidad_bultos: 1,
    kg_bulto: producto.presentacion_kg,
    kg_editado: false,
    precio_kg: null,
  };
}

/**
 * Cambia la cantidad de bultos.
 *
 * `cero` se vuelve a uno y no a cero, y lo que no se puede leer se IGNORA.
 * Es exactamente la regla del POS (`notas/linea.ts`) y por el mismo motivo:
 * `cantidad_bultos` es un `decimal(8, 2, ...)` del backend que RECHAZA el
 * cero, y un "abc" a medio teclear no es un cero que se deba corregir solo.
 */
export function cambiarCantidad(linea: LineaCompra, cantidad: number | string): LineaCompra {
  const numero = Number(cantidad);
  if (!Number.isFinite(numero)) return linea;
  return { ...linea, cantidad_bultos: numero > 0 ? numero : 1 };
}

/**
 * Cambia los kilos por bulto a mano.
 *
 * El cero y el negativo no se aceptan (el backend exige `> 0`) y devuelven la
 * linea como estaba. Ponerlos igual a la presentacion los deja por editar,
 * que es como decir "no los toque".
 */
export function cambiarKilos(linea: LineaCompra, kilos: number | string): LineaCompra {
  const numero = Number(kilos);
  if (!Number.isFinite(numero) || numero <= 0) return linea;
  return { ...linea, kg_bulto: numero, kg_editado: numero !== linea.presentacion_kg };
}

/**
 * Escribe el costo por kilo, o lo borra.
 *
 * Un campo vacio es `null` y significa "que lo resuelva el sistema": es el
 * estado normal de un renglon, no un error. Un numero negativo o ilegible se
 * ignora; el cero SI se guarda, porque un producto de cortesia vale cero y el
 * `precioKg` del backend lo acepta.
 */
export function ponerPrecio(linea: LineaCompra, valor: number | string): LineaCompra {
  if (valor === '') return { ...linea, precio_kg: null };
  const numero = Number(valor);
  if (!Number.isFinite(numero) || numero < 0) return linea;
  return { ...linea, precio_kg: numero };
}

/** Agrega el renglon. No fusiona: dos lotes del mismo producto son dos filas. */
export function agregar(lineas: LineaCompra[], linea: LineaCompra): LineaCompra[] {
  return [...lineas, linea];
}

/** Quita el renglon. Por `uid`, no por producto: hay una fila por uid. */
export function quitar(lineas: LineaCompra[], uid: number): LineaCompra[] {
  return lineas.filter((linea) => linea.uid !== uid);
}

/** Total de kilos de una linea, con los tres decimales de `kg_bulto`. */
export function kilosDeLinea(linea: LineaCompra): string {
  return kilosComoTexto(linea.cantidad_bultos * linea.kg_bulto);
}

/** Los kilos de toda la compra, que son los que entran a la bodega. */
export function kilosDeLineas(lineas: LineaCompra[]): number {
  return lineas.reduce((suma, linea) => suma + linea.cantidad_bultos * linea.kg_bulto, 0);
}

/**
 * El subtotal de una linea, en pantalla.
 *
 * Es un PREVISUALIZADO y ademas puede quedarse corto: si el costo no se
 * escribio (`precio_kg === null`) vale 0, porque desde el navegador no se
 * puede saber que ultimo costo va a resolver el backend. El subtotal que vale
 * es el que calcula Postgres al guardar (`cantidad_bultos * kg_bulto *
 * precio_kg`), y es el que se muestra en el comprobante.
 */
export function subtotalDeLinea(linea: LineaCompra): number {
  if (linea.precio_kg === null) return 0;
  return redondearMonto(linea.cantidad_bultos * linea.kg_bulto * linea.precio_kg);
}

/** Si a la linea todavia no se le escribio el costo (lo resuelve el sistema). */
export function sinCostoEscrito(linea: LineaCompra): boolean {
  return linea.precio_kg === null;
}

/** El total de la compra: la suma de los subtotales que se conocen. */
export function totalDeLineas(lineas: LineaCompra[]): number {
  return redondearMonto(lineas.reduce((suma, linea) => suma + subtotalDeLinea(linea), 0));
}

/** El subtotal de la linea, en dinero. */
export function montoDeLinea(linea: LineaCompra): string {
  return montoComoTexto(subtotalDeLinea(linea));
}

/**
 * Que problemas tiene un renglon, para encender los campos en vez de dejar
 * que la persona mande algo que el backend va a rechazar.
 *
 * Las reglas son un espejo de `renglonCompraEsquema` y de `core/valores.ts`:
 * los mismos topes de cifras y de decimales que `decimal(8,2)`,
 * `decimal(7,3)` y `precioKg`. El `precio_kg` vacio NO es un problema: lo
 * resuelve el backend, y si no encuentra costo responde `SIN_COSTO`, que la
 * pantalla explica con nombre y todo.
 */
export function problemasDe(linea: LineaCompra): Record<string, string> {
  const problemas: Record<string, string> = {};

  if (!positivoCon(linea.cantidad_bultos, 8, 2)) {
    problemas['cantidad_bultos'] = 'La cantidad debe ser un número positivo con hasta 2 decimales';
  }
  if (!positivoCon(linea.kg_bulto, 7, 3)) {
    problemas['kg_bulto'] = 'Los kilos por bulto tienen que ser más de cero';
  }
  if (linea.precio_kg !== null && !noNegativoCon(linea.precio_kg, 8, 2)) {
    problemas['precio_kg'] = 'El precio debe ser un número con hasta 2 decimales';
  }

  return problemas;
}

/** Si el renglon se puede mandar tal cual. */
export function lineaValida(linea: LineaCompra): boolean {
  return Object.keys(problemasDe(linea)).length === 0;
}

/**
 * El `cantidad_bultos` que va en el JSON, como texto.
 *
 * Se manda texto y no numero a proposito: el backend lo acepta en las dos
 * formas y lo convierte a texto antes de validarlo, y mandar texto quita de
 * en medio el double de JavaScript.
 */
export function cantidadComoTexto(linea: LineaCompra): string {
  return decimalComoTexto(linea.cantidad_bultos, 2);
}

/** Los kilos por bulto, si la persona los toco. Si no, no se mandan. */
export function kilosComoTextoSiEditados(linea: LineaCompra): string | null {
  if (!linea.kg_editado) return null;
  return decimalComoTexto(linea.kg_bulto, 3);
}

/** El precio por kilo, si la persona lo escribio. Si no, no se manda. */
export function precioComoTextoSiEscrito(linea: LineaCompra): string | null {
  if (linea.precio_kg === null) return null;
  return decimalComoTexto(linea.precio_kg, 2);
}

/** Un positivo con el patron `^\d{1,enteros}(\.\d{1,decimales})?$` y `> 0`. */
function positivoCon(valor: number, enteros: number, decimales: number): boolean {
  const texto = String(valor);
  return (
    new RegExp(`^\\d{1,${enteros}}(\\.\\d{1,${decimales}})?$`).test(texto) && Number(texto) > 0
  );
}

/** Como `positivoCon` pero el cero SI pasa: es el `precioKg` del backend. */
function noNegativoCon(valor: number, enteros: number, decimales: number): boolean {
  const texto = String(valor);
  return new RegExp(`^\\d{1,${enteros}}(\\.\\d{1,${decimales}})?$`).test(texto);
}
