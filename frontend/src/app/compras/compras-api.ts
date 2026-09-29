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
 * La API de compras.
 *
 * Es el espejo de `backend/src/modules/compras`. Los tipos de aqui salen de
 * `compras/modelo.ts` y los esquemas del cuerpo de `compras/esquemas.ts`, y no
 * se comparten (el front y el back son dos paquetes): cuando cambie una forma
 * hay que cambiar el tipo de este archivo. Por eso cada uno lleva anotado de
 * que archivo del backend salio.
 *
 * Cuatro decisiones que no se ven en los tipos y si en las reglas:
 *
 *   - **No hay editar.** Una compra ya escrita se deshace CANCELANDOLA (con
 *     motivo), no editando sus renglones: editarlos dejaria el inventario con
 *     la entrada vieja y la nueva. Por eso no hay `actualizar`, solo `crear` y
 *     `cancelar`.
 *   - **No hay borrar.** Cancelar no borra: deja el documento con estatus
 *     'cancelada' y su motivo, y el trigger devuelve los bultos a la bodega.
 *   - **`estatus` y `subtotal` NO se mandan.** El estatus lo mueven los pagos
 *     al proveedor (que todavia no tienen API, asi que una compra nace
 *     'pendiente' y ahi se queda) y el `subtotal` es GENERATED en la base.
 *     Los dos los rechazaria el `.strict()` del esquema.
 *   - **`precio_kg` es opcional.** Si no se manda, el servicio lo saca del
 *     ultimo costo vigente de ESE proveedor para ESE producto en la fecha de
 *     la compra (`producto_proveedor_precios`). Si tampoco hay costo, es un
 *     422 `SIN_COSTO`: el costo hay que escribirlo alguna vez.
 */

// --------------------------------------------------------------------- tipos

/** `compras/modelo.ts` -> `EstatusCompra`. Lo cambian los pagos (aun sin API). */
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
  /** Cuantos renglones tiene. Es un conteo de la fila, no una columna. */
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
  /** Lo calcula Postgres: `cantidad_bultos * kg_bulto * precio_kg`. */
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

/** `proveedores/modelo.ts` -> lo que el POS y compras necesitan del proveedor. */
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
 * Un renglon de compra, tal como lo quiere `renglonCompraEsquema`.
 *
 * `kg_bulto` y `precio_kg` son opcionales y los dos tienen el mismo sentido:
 * si no van, los resuelve el backend (la presentacion del producto y el
 * ultimo costo del proveedor), que es el dato bueno. Mandarlos solo cuando la
 * persona los escribio evita que el navegador imponga su copia.
 */
export interface RenglonCompraBody {
  producto_id: number;
  almacen_id: number;
  cantidad_bultos: string;
  kg_bulto?: string;
  precio_kg?: string;
}

/** El `POST /api/compras`, tal como lo quiere `crearCompraEsquema`. */
export interface CuerpoCompra {
  proveedor_id: number;
  folio_proveedor?: string;
  fecha?: string;
  renglones: RenglonCompraBody[];
}

/**
 * El almacen que recibe la mercancia.
 *
 * `almacenes.id` es un SMALLINT y no hay endpoint de almacenes todavia. La
 * semilla crea una sola bodega ('Bodega BUAP') y compras entra ahi. Es lo
 * unico de la pantalla escrito a mano, y es el primer lugar que hay que tocar
 * cuando haya mas de una: o llega el endpoint y se sustituye por la que elija
 * la persona, o se admite que solo hay una. Lo que no puede ser es que quede
 * en un 1 sin que nadie lo sepa.
 */
export const ALMACEN_ID = 1;

/**
 * Arma el cuerpo de la compra.
 *
 * La fecha NO se manda si viene vacia: sin ella la usa la base
 * (`hoyEnLaBase`), que es la fecha del servidor y no la del navegador. La
 * fecha solo viaja cuando la persona escribio la del documento del proveedor,
 * que puede ser otro dia.
 *
 * El `folio_proveedor` vacio tampoco se manda: no hay `null` que limpiar
 * porque una compra no se edita, y mandar `""` seria un folio de cero letras.
 */
export function cuerpoDeCompra(
  proveedorId: number,
  lineas: LineaCompra[],
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
        almacen_id: ALMACEN_ID,
        cantidad_bultos: cantidadComoTexto(linea),
        ...(kilos === null ? {} : { kg_bulto: kilos }),
        ...(precio === null ? {} : { precio_kg: precio }),
      };
    }),
  };

  const folioLimpio = folio?.trim();
  if (folioLimpio) cuerpo.folio_proveedor = folioLimpio;

  // La fecha se valida como `AAAA-MM-DD` con un patron y no se reenvia tal
  // cual: un `<input type="date">` en un navegador raro puede devolver texto
  // a medias, y el backend lo rechazaria con un 422 sobre un campo que ya se
  // ve bien en pantalla.
  const fechaLimpia = fecha?.trim();
  if (fechaLimpia && /^\d{4}-\d{2}-\d{2}$/.test(fechaLimpia)) cuerpo.fecha = fechaLimpia;

  return cuerpo;
}

// --------------------------------------------------------------- las llamadas

@Injectable({ providedIn: 'root' })
export class ComprasApi {
  private readonly http = inject(HttpClient);

  /**
   * Lista con filtros y paginacion.
   *
   * El esquema del listado es `strict`: mandar un parametro que no este
   * (`activo`, por ejemplo, que es de proveedores) da un 400. Por eso el
   * objeto de opciones es cerrado y solo se copian los campos definidos.
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

  /** Crea. 201 + la compra con sus renglones y el `monto_total` de la base. */
  async crear(cuerpo: CuerpoCompra): Promise<Compra> {
    return firstValueFrom(this.http.post<Compra>(`${API}/compras`, cuerpo));
  }

  /**
   * Cancela, con el motivo obligatorio.
   *
   * No se puede cancelar una compra que ya tiene pagos: el backend responde
   * `COMPRA_CON_PAGO` (409) porque el dinero ya salio y no hay forma de
   * regresarlo todavia. La pantalla lo dice tal cual.
   */
  async cancelar(id: number, motivo: string): Promise<Compra> {
    return firstValueFrom(
      this.http.post<Compra>(`${API}/compras/${id}/cancelar`, { motivo: motivo.trim() }),
    );
  }

  /**
   * Busca proveedores ACTIVOS para el selector.
   *
   * `activo=true` porque no se le compra a un proveedor dado de baja: el
   * backend lo rechazaria con `PROVEEDOR_INACTIVO`, asi que no tiene sentido
   * ofrecerlo. El minimo de dos caracteres es el de siempre.
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
   * Busca productos por codigo o nombre.
   *
   * Un caracter alcanza, como en el POS: los productos se distinguen por una
   * clave corta (`LAC`, `DHP`) y el operador teclea el codigo.
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
}

/**
 * El estatus en palabras, para la tabla.
 *
 * `pendiente` es el unico estatus en el que puede nacer una compra hoy: los
 * otros los mueven los pagos al proveedor, que todavia no tienen pantalla.
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
