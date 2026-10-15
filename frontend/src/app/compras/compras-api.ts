import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { API } from '../nucleo/api';
import {
  cantidadComoTexto,
  kilosComoTextoSiEditados,
  precioComoTextoSiEscrito,
  type LineaCompra,
} from './linea';

/**
 * El servicio de compras.
 *
 * Los tipos de aquí salen de `compras/modelo.ts` y las reglas de validación de
 * los datos de `compras/esquemas.ts`, y no se comparten con el sistema (son dos
 * partes): cuando cambie una forma hay que cambiar el tipo de este archivo.
 * Por eso cada uno lleva anotado de qué archivo del sistema salió.
 *
 * Cuatro decisiones que no se ven en los tipos y sí en las reglas:
 *
 *   - **No hay editar.** Una compra ya escrita se deshace CANCELÁNDOLA (con
 *     motivo), no editando sus renglones: editarlos dejaría el inventario con
 *     la entrada vieja y la nueva. Por eso no hay `actualizar`, solo `crear` y
 *     `cancelar`.
 *   - **No hay borrar.** Cancelar no borra: deja el documento con estatus
 *     'cancelada' y su motivo, y la regla automática del sistema devuelve los
 *     bultos a la bodega.
 *   - **`estatus` y `subtotal` NO se mandan.** El estatus lo mueven los pagos
 *     al proveedor (`pagar`) y el `subtotal` lo calcula el sistema. Los dos los
 *     rechazarían las reglas de validación.
 *   - **Se paga, no se edita.** El abono que deja la compra 'pagada' lo
 *     registra el servicio al pagar, por el monto que falte.
 *   - **`precio_kg` es opcional.** Si no se manda, el sistema lo saca del
 *     último costo vigente de ESE proveedor para ESE producto en la fecha de
 *     la compra (`producto_proveedor_precios`). Si tampoco hay costo, es un
 *     422 `SIN_COSTO`: el costo hay que escribirlo alguna vez.
 */

// --------------------------------------------------------------------- tipos

/** `compras/modelo.ts` -> `EstatusCompra`. Lo cambian los pagos (aún sin pantalla). */
export type EstatusCompra = 'pendiente' | 'parcial' | 'pagada' | 'cancelada';

/** `compras/modelo.ts` -> `CompraListada`. La fila de la tabla. */
export interface CompraListada {
  id: number;
  proveedor_id: number;
  proveedor: string;
  fecha: string;
  folio_proveedor: string | null;
  monto_total: number;
  estatus: EstatusCompra;
  /** Cuántos renglones tiene. Es un conteo de la fila, no una columna. */
  renglones: number;
}

/** `compras/modelo.ts` -> `RenglonCompra`. */
export interface RenglonCompra {
  id: number;
  producto_id: number;
  producto_codigo: string;
  producto_nombre: string;
  almacen_id: number;
  almacen: string;
  cantidad_bultos: number;
  kg_bulto: number;
  precio_kg: number;
  /** Lo calcula el sistema: `cantidad_bultos * kg_bulto * precio_kg`. */
  subtotal: number;
}

/** `compras/modelo.ts` -> `Compra`. Lo que devuelven el alta y el detalle. */
export interface Compra {
  id: number;
  proveedor_id: number;
  proveedor: string;
  fecha: string;
  folio_proveedor: string | null;
  monto_total: number;
  estatus: EstatusCompra;
  motivo_cancelacion: string | null;
  creado_en: string;
  renglones: RenglonCompra[];
}

/** La envoltura de los listados (`compras/servicio.ts`), como productos. */
export interface ListaCompras {
  datos: CompraListada[];
  total: number;
  limite: number;
  offset: number;
}

/** `proveedores/modelo.ts` -> lo que el mostrador y compras necesitan del proveedor. */
export interface ProveedorOpcion {
  id: number;
  nombre: string;
  activo: boolean;
}

/** `productos/modelo.ts` -> lo que compras necesita del producto. */
export interface ProductoOpcion {
  id: number;
  codigo: string;
  nombre: string;
  presentacion_kg: number;
  activo: boolean;
}

// ------------------------------------------------------------------ el cuerpo

/**
 * Un renglón de compra, tal como lo piden las reglas de validación
 * (`renglonCompraEsquema`).
 *
 * `kg_bulto` y `precio_kg` son opcionales y los dos tienen el mismo sentido:
 * si no van, los resuelve el sistema (la presentación del producto y el último
 * costo del proveedor), que es el dato bueno. Mandarlos solo cuando la persona
 * los escribió evita que el navegador imponga su copia.
 */
export interface RenglonCompraBody {
  producto_id: number;
  almacen_id: number;
  cantidad_bultos: string;
  kg_bulto?: string;
  precio_kg?: string;
}

/** Los datos al crear una compra, tal como los pide `crearCompraEsquema`. */
export interface CuerpoCompra {
  proveedor_id: number;
  folio_proveedor?: string;
  fecha?: string;
  renglones: RenglonCompraBody[];
}

/**
 * El almacén que recibe la mercancía.
 *
 * `almacenes.id` es un número pequeño y el catálogo de almacenes se sirve
 * desde `catalogo/`, la misma parte que especies y categorías. La pantalla lo
 * elige al abrir el alta y lo pasa aquí por parámetro: ya no hay un 1 escrito
 * a mano, y si la bodega falta, el alta se bloquea ANTES de llegar al sistema
 * en vez de responder "El almacén 1 no existe".
 */
export interface Almacen {
  id: number;
  nombre: string;
}

/**
 * Arma los datos de la compra.
 *
 * El almacén va por parámetro: es el que la pantalla consulta al abrir el alta
 * (`Catálogo › Almacenes`) y no una constante, porque si mañana hay más de una
 * bodega esto ya no se toca.
 *
 * La fecha NO se manda si viene vacía: sin ella la usa el sistema
 * (`hoyEnLaBase`), que es la fecha del sistema y no la del navegador. La fecha
 * solo viaja cuando la persona escribió la del documento del proveedor, que
 * puede ser otro día.
 *
 * El `folio_proveedor` vacío tampoco se manda: no hay `null` que limpiar
 * porque una compra no se edita, y mandar `""` sería un folio de cero letras.
 */
export function cuerpoDeCompra(
  proveedorId: number,
  lineas: LineaCompra[],
  almacenId: number,
  folio?: string | null,
  fecha?: string | null,
): CuerpoCompra {
  if (lineas.length === 0) {
    throw new Error('Una compra necesita al menos un renglon');
  }

  const cuerpo: CuerpoCompra = {
    proveedor_id: proveedorId,
    renglones: lineas.map((linea) => {
      const kilos = kilosComoTextoSiEditados(linea);
      const precio = precioComoTextoSiEscrito(linea);
      return {
        producto_id: linea.producto_id,
        almacen_id: almacenId,
        cantidad_bultos: cantidadComoTexto(linea),
        ...(kilos === null ? {} : { kg_bulto: kilos }),
        ...(precio === null ? {} : { precio_kg: precio }),
      };
    }),
  };

  const folioLimpio = folio?.trim();
  if (folioLimpio) cuerpo.folio_proveedor = folioLimpio;

  // La fecha se revisa como `AAAA-MM-DD` con un patrón y no se reenvía tal
  // cual: un campo de fecha en un navegador raro puede devolver texto a
  // medias, y el sistema lo rechazaría con un 422 sobre un campo que ya se ve
  // bien en pantalla.
  const fechaLimpia = fecha?.trim();
  if (fechaLimpia && /^\d{4}-\d{2}-\d{2}$/.test(fechaLimpia)) cuerpo.fecha = fechaLimpia;

  return cuerpo;
}

// --------------------------------------------------------------- las llamadas

@Injectable({ providedIn: 'root' })
export class ComprasApi {
  private readonly http = inject(HttpClient);

  /**
   * Lista con filtros y paginación.
   *
   * Las reglas de validación del listado no admiten campos de más: mandar un
   * parámetro que no exista (`activo`, por ejemplo, que es de proveedores) da
   * un 400. Por eso el objeto de opciones es cerrado y solo se copian los
   * campos definidos.
   */
  async listar(opciones: {
    buscar?: string;
    proveedor_id?: number;
    estatus?: EstatusCompra;
    desde?: string;
    hasta?: string;
    limite?: number;
    offset?: number;
  }): Promise<ListaCompras> {
    const params: Record<string, string | number> = {
      limite: opciones.limite ?? 50,
      offset: opciones.offset ?? 0,
    };
    if (opciones.buscar) params['buscar'] = opciones.buscar;
    if (opciones.proveedor_id !== undefined) params['proveedor_id'] = opciones.proveedor_id;
    if (opciones.estatus) params['estatus'] = opciones.estatus;
    if (opciones.desde) params['desde'] = opciones.desde;
    if (opciones.hasta) params['hasta'] = opciones.hasta;
    return firstValueFrom(this.http.get<ListaCompras>(`${API}/compras`, { params }));
  }

  /** El detalle con sus renglones. */
  async consultar(id: number): Promise<Compra> {
    return firstValueFrom(this.http.get<Compra>(`${API}/compras/${id}`));
  }

  /** Crea. 201 + la compra con sus renglones y el `monto_total` que calcula el sistema. */
  async crear(cuerpo: CuerpoCompra): Promise<Compra> {
    return firstValueFrom(this.http.post<Compra>(`${API}/compras`, cuerpo));
  }

  /**
   * Cancela, con el motivo obligatorio.
   *
   * No se puede cancelar una compra que ya tiene pagos: el sistema responde
   * `COMPRA_CON_PAGO` (409) porque el dinero ya salió y no hay forma de
   * regresarlo todavía. La pantalla lo dice tal cual.
   */
  async cancelar(id: number, motivo: string): Promise<Compra> {
    return firstValueFrom(
      this.http.post<Compra>(`${API}/compras/${id}/cancelar`, { motivo: motivo.trim() }),
    );
  }

  /**
   * Marca la compra como pagada de una vez.
   *
   * El abono va por EXACTAMENTE lo que falta (el sistema lo calcula: total
   * menos lo ya abonado), para que el saldo del proveedor no se pase de
   * ceros. Devuelve la compra ya con su nuevo estatus; la fecha del abono la
   * pone el sistema (hoy del sistema).
   */
  async pagar(id: number): Promise<Compra> {
    return firstValueFrom(this.http.post<Compra>(`${API}/compras/${id}/pagar`, {}));
  }

  /**
   * Busca proveedores ACTIVOS para el selector.
   *
   * `activo=true` porque no se le compra a un proveedor dado de baja: el
   * sistema lo rechazaría con `PROVEEDOR_INACTIVO`, así que no tiene sentido
   * ofrecerlo. El mínimo de dos caracteres es el de siempre.
   */
  async proveedores(buscar: string): Promise<ProveedorOpcion[]> {
    if (buscar.trim().length < 2) return [];
    const respuesta = await firstValueFrom(
      this.http.get<{ datos: ProveedorOpcion[] }>(`${API}/proveedores`, {
        params: { buscar: buscar.trim(), activo: 'true', limite: 20 },
      }),
    );
    return respuesta.datos;
  }

  /**
   * Busca productos por código o nombre.
   *
   * Un carácter alcanza, como en el punto de venta: los productos se
   * distinguen por una clave corta (`LAC`, `DHP`) y el operador teclea el
   * código.
   */
  async productos(buscar: string): Promise<ProductoOpcion[]> {
    if (buscar.trim().length < 1) return [];
    const respuesta = await firstValueFrom(
      this.http.get<{ datos: ProductoOpcion[] }>(`${API}/productos`, {
        params: { buscar: buscar.trim(), limite: 20 },
      }),
    );
    return respuesta.datos;
  }

  /**
   * Las bodegas a donde puede entrar la mercancía.
   *
   * Llenan el selector del alta. Antes esto era un 1 escrito a mano y si la
   * bodega faltaba el alta respondía "El almacén 1 no existe": ahora la
   * pantalla ofrece las que hay, y si no hay ninguna, se puede crear una en el
   * acto (solo quien tenga `almacenes.crear`).
   */
  async almacenes(): Promise<Almacen[]> {
    const respuesta = await firstValueFrom(this.http.get<{ datos: Almacen[] }>(`${API}/almacenes`));
    return respuesta.datos;
  }

  /**
   * Crea una bodega desde el mismo alta de compras.
   *
   * Solo aparece cuando la lista está vacía y quien captura tiene permiso
   * (`almacenes.crear`, del Administrador): con el sistema recién entregado
   * no hay ninguna y la primera compra no se topa con un "almacén 1 no
   * existe". El 409 `NOMBRE_DUPLICADO` lo traduce la pantalla en el aviso del
   * editor.
   */
  async crearAlmacen(nombre: string): Promise<Almacen> {
    return firstValueFrom(this.http.post<Almacen>(`${API}/almacenes`, { nombre: nombre.trim() }));
  }
}

/**
 * El estatus en palabras, para la tabla.
 *
 * `pendiente` es el único estatus en el que puede nacer una compra hoy: los
 * otros los mueven los abonos del proveedor (`pagar`).
 */
export function estatusComoTexto(estatus: EstatusCompra): string {
  switch (estatus) {
    case 'pendiente':
      return 'Por pagar';
    case 'parcial':
      return 'Pago parcial';
    case 'pagada':
      return 'Pagada';
    case 'cancelada':
      return 'Cancelada';
  }
}
