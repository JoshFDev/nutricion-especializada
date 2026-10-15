import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { API } from '../nucleo/api';
import { cantidadComoTexto, kgComoTextoSiHayQueMandarlo, type Linea } from './linea';

/**
 * El servicio de notas del mostrador: clientes, productos, precios y el alta
 * de la nota.
 *
 * Los tipos de aquí son una copia de los que usa el servicio. No se comparten
 * (las dos partes son programas aparte), así que cuando cambie una forma hay
 * que cambiar el tipo de este archivo; por eso cada uno anota de dónde salió.
 *
 * Ninguna pantalla se queda "escuchando": todo se pide y se espera la
 * respuesta. Un mostrador son clics sueltos, no un formulario con muchos
 * campos a la vez, y el estado de "guardando" se maneja con una señal.
 */

// --------------------------------------------------------------------- tipos

/** `clientes/modelo.ts` -> `Cliente`. La pantalla usa el id, el nombre y el rfc. */
export interface Cliente {
  id: number;
  codigo_cliente: string | null;
  nombre: string;
  establo: string | null;
  rfc: string | null;
}

/** `productos/modelo.ts` -> `Producto`. */
export interface Producto {
  id: number;
  codigo: string;
  nombre: string;
  presentacion_kg: number;
  activo: boolean;
}

/** `precios/repositorio.ts` -> lo que devuelve `resolverEfectivo`. */
export interface PrecioEfectivo {
  fecha: string;
  producto_id: number;
  producto_codigo: string;
  producto_nombre: string;
  /** `false` cuando el precio existe pero ya venció: hay que decirlo. */
  vigente: boolean;
  origen: 'cliente' | 'publico' | null;
  precio_id: number | null;
  precio_kg: number | null;
  vigente_desde: string | null;
  vigente_hasta: string | null;
}

/** `inventario/modelo.ts` -> `Existencia`. La pantalla usa solo `existencia_bultos`. */
export interface Existencia {
  producto_id: number;
  almacen_id: number;
  /** En BULTOS, que es la unidad con la que se compra y se vende. */
  existencia_bultos: number;
}

/** `notas-remision/modelo.ts` -> `Renglon`. */
export interface RenglonNota {
  id: number;
  producto_id: number;
  producto_codigo: string;
  producto_nombre: string;
  almacen_id: number;
  almacen: string;
  cantidad_bultos: number;
  kg_bulto: number;
  precio_unit_kg: number;
  subtotal: number;
}

/** `notas-remision/modelo.ts` -> `Nota`. */
export interface Nota {
  id: number;
  folio_id: number;
  folio: string;
  cliente_id: number;
  cliente: string;
  vendedor_id: number | null;
  vendedor: string | null;
  fecha: string;
  direccion_entrega: string | null;
  subtotal: number;
  estatus: EstatusNota;
  motivo_cancelacion: string | null;
  creado_en: string;
  actualizado_en: string;
  renglones: RenglonNota[];
}

export type EstatusNota = 'pendiente' | 'parcial' | 'pagada' | 'cancelada';

/**
 * `notas-remision/modelo.ts` -> `NotaListada`: el renglón de la tabla de abajo.
 *
 * NO trae el detalle de los renglones (traerlo para 50 notas sería pintar 50
 * tablas enteras), solo cuántos tiene. El detalle se pide con `consultar`
 * cuando la persona abre una fila.
 */
export interface NotaListada {
  id: number;
  folio: string;
  cliente_id: number;
  cliente: string;
  vendedor: string | null;
  fecha: string;
  subtotal: number;
  estatus: EstatusNota;
  renglones: number;
  /** Los kilos que salen en el camión, sumados de los renglones. */
  kg_total: number;
}

/**
 * El periodo del listado. `hoy` y `ultimos_7` los resuelve el propio sistema
 * (`periodosEsquema` en `notas-remision/esquemas.ts`), no el navegador: la
 * fecha de una nota la decide la fecha del sistema, y un filtro armado con la
 * fecha del navegador deja fuera la nota que se acaba de capturar cuando la
 * máquina del mostrador y el sistema están en días distintos.
 *
 * `'todo'` no existe como filtro: es la ausencia de filtro, y se manda
 * `undefined`.
 */
export type Periodo = 'hoy' | 'ultimos_7';

/**
 * Cómo se pide el listado ordenado. Son las cuatro combinaciones que ofrece
 * el desplegable de la pantalla, y son las ÚNICAS que el sistema acepta: la
 * validación solo permite estas, para que nadie pueda pedir un orden que no se
 * pueda resolver.
 */
export type OrdenNotas = 'fecha_desc' | 'fecha_asc' | 'subtotal_desc' | 'subtotal_asc';

/** Lo que el desplegable muestra, y a qué opción corresponde. */
export const ORDENES_NOTAS: { valor: OrdenNotas; texto: string }[] = [
  { valor: 'fecha_desc', texto: 'Más recientes primero' },
  { valor: 'fecha_asc', texto: 'Más antiguas primero' },
  { valor: 'subtotal_desc', texto: 'Mayor total primero' },
  { valor: 'subtotal_asc', texto: 'Menor total primero' },
];

export interface FiltroNotas {
  periodo?: Periodo;
  buscar?: string;
  fecha_desde?: string;
  fecha_hasta?: string;
  ordenar: OrdenNotas;
  limite?: number;
  offset?: number;
}

/** El molde con el que llegan las listas. `notas-remision/modelo.ts` -> `Listado`. */
export interface Listado<T> {
  datos: T[];
  total: number;
  limite: number;
  offset: number;
}

/** `notas-remision/modelo.ts` -> `Folio`: un número del talonario. */
export interface Folio {
  id: number;
  serie: string;
  folio_numero: number;
  completo: string;
  estatus: 'disponible' | 'usado' | 'cancelado';
  nota_id: number | null;
}

/** `notas-remision/modelo.ts` -> `ResumenTalonario`. */
export interface ResumenTalonario {
  serie: string;
  ejemplo: string;
  minimo: number | null;
  maximo: number | null;
  disponibles: number;
  usados: number;
  cancelados: number;
}

/** Lo que se manda al cargar un tramo de talonario. */
export interface CuerpoTalonario {
  serie: string;
  desde: number;
  hasta: number;
}

// ------------------------------------------------------------------ el cuerpo

/**
 * Lo que se manda al crear una nota, tal como lo pide el sistema.
 *
 * Lo que se ve aquí, y no en la pantalla, es lo que se decide NO mandar:
 *
 *   - `serie`: NO se manda. El talonario del que sale el folio es la "serie
 *     activa" que dejó puesta quien administra `notas.folios`, y el sistema
 *     la resuelve si no la trae. El mostrador no debe saber qué serie toca
 *     hoy: eso cambió en la oficina, no en el mostrador.
 *   - `subtotal`: NO existe. Es un dato que el sistema calcula solo, y su
 *     validación es estricta, así que mandarlo provoca un rechazo con un
 *     mensaje poco claro. Es el error más confuso de todos.
 *   - `precio_unit_kg`: NO se manda, aunque la pantalla ya sepa el precio.
 *     El sistema lo resuelve en la FECHA DE LA NOTA si no llega
 *     (`prepararRenglones` -> `resolverEfectivo`), que es la regla del
 *     negocio; mandarlo desde la pantalla abriría la puerta a que un precio
 *     de 0.01 cobrara casi nada. El precio que se ve en el renglón es el
 *     mismo que va a resolver el sistema con la misma fecha y el mismo
 *     cliente.
 *   - `fecha`: NO se manda, y por lo mismo: si no viene, la usa el sistema
 *     (`hoyEnLaBase`). Mandarla desde el navegador es como la fecha se corre
 *     un día en otra zona horaria.
 *   - `kg_bulto`: solo si la persona lo tocó. Si no, lo rellena
 *     `fn_default_kg_bulto` con `productos.presentacion_kg`, que es la
 *     presentación real del producto y no la que el navegador recuerda.
 *   - `id`: los renglones de una nota nueva no tienen id todavía.
 */
export interface CuerpoNota {
  cliente_id: number;
  direccion_entrega?: string | null;
  renglones: RenglonNotaBody[];
}

export interface RenglonNotaBody {
  producto_id: number;
  almacen_id: number;
  cantidad_bultos: string;
  kg_bulto?: string;
}

/**
 * Lo que se manda al corregir una nota, tal como lo pide el sistema.
 *
 * Tres diferencias con lo que se manda al crear, y las tres son obligatorias:
 *
 *   - `renglones[].id`: sin él, el sistema no puede distinguir "este renglón
 *     ya estaba" de "este es nuevo", y cada guardado borraría todos los
 *     renglones y los volvería a crear. Con los renglones borrados y
 *     recreados, sus movimientos de inventario también se borran y se
 *     rehacen: una devolución terminaría con el inventario lleno de ruido.
 *     Los que la persona quitó de la tabla (una devolución completa) no
 *     vienen, y el sistema los borra de verdad.
 *   - `almacen_id`: se toma del renglón (`RenglonNota.almacen_id`). Al crear
 *     la nota la bodega la elige la pantalla; al corregir una nota, el
 *     producto puede haber salido de otra bodega, y mandarle el almacén
 *     equivocado descuenta la mercancía de la que no es. La bodega de la
 *     pantalla solo rellena los renglones NUEVOS que se agreguen.
 *   - `precio_unit_kg`: tampoco se manda, y por la misma razón que al crear.
 *     El sistema conserva el precio de los renglones que ya estaban (ver
 *     `prepararRenglones` -> `aConservar` en el servicio), que es lo que se
 *     cobró. Bajar bultos en una devolución no puede cambiar el precio por
 *     kilo de lo que quedó.
 */
export interface CuerpoEdicion {
  cliente_id: number;
  direccion_entrega: string | null;
  renglones: RenglonEdicionBody[];
}

export interface RenglonEdicionBody {
  id?: number;
  producto_id: number;
  almacen_id: number;
  cantidad_bultos: string;
  kg_bulto?: string;
}

/**
 * El almacén del que sale la venta.
 *
 * Las bodegas vienen del catálogo (`catalogo/`), el mismo que especies y
 * categorías. La pantalla lo elige en la captura y lo pasa aquí: ya no hay un
 * 1 escrito a mano, y si no hay bodega el guardado se bloquea ANTES de
 * intentarlo, en vez de responder "El almacén 1 no existe".
 *
 * Al CREAR la nota la bodega es una sola para toda la nota. Al CORREGIR cada
 * renglón conserva la suya (`RenglonNota.almacen_id`): el producto puede
 * haber salido de otra bodega, y mandarle el almacén equivocado descuenta la
 * mercancía de la que no es. La bodega elegida solo rellena los renglones
 * NUEVOS que se agreguen al corregir.
 */
export interface Almacen {
  id: number;
  nombre: string;
}

/** Arma lo que se manda al crear la nota. */
export function cuerpoDeNota(
  clienteId: number,
  lineas: Linea[],
  almacenId: number,
  direccion?: string | null,
): CuerpoNota {
  if (lineas.length === 0) {
    throw new Error('Una nota necesita al menos un renglon');
  }

  const cuerpo: CuerpoNota = {
    cliente_id: clienteId,
    renglones: lineas.map((linea) => {
      const kilos = kgComoTextoSiHayQueMandarlo(linea);
      return {
        producto_id: linea.producto_id,
        almacen_id: almacenId,
        cantidad_bultos: cantidadComoTexto(linea),
        ...(kilos === null ? {} : { kg_bulto: kilos }),
      };
    }),
  };

  // La dirección es opcional y vacía no es lo mismo que ninguna: se manda
  // `null` para BORRAR la que tuviera, y por eso se permite que vaya vacía.
  // Sin esto, una nota editada nunca podría quedar sin dirección.
  const limpia = direccion?.trim();
  if (limpia) cuerpo.direccion_entrega = limpia;

  return cuerpo;
}

/**
 * Arma lo que se manda al corregir la nota (la devolución).
 *
 * A diferencia de cuando se crea, aquí la dirección se manda SIEMPRE, aunque
 * vaya vacía: al corregir, la dirección vacía es una orden de quitar la que
 * la nota tenía, y mandarla solo cuando hay texto impediría quitarla. Al
 * crear no hay nada que quitar (la nota no existía), así que ahí sí vale la
 * regla de "solo si hay algo".
 */
export function cuerpoDeEdicion(
  clienteId: number,
  lineas: Linea[],
  almacenId: number,
  direccion: string,
): CuerpoEdicion {
  if (lineas.length === 0) {
    // Un renglón de menos es una devolución; una nota sin renglones es un
    // documento que no existe. Cancelarla es otra cosa y tiene otro botón.
    throw new Error('Una nota necesita al menos un renglon');
  }

  return {
    cliente_id: clienteId,
    direccion_entrega: direccion.trim() === '' ? null : direccion.trim(),
    renglones: lineas.map((linea) => {
      const kilos = kgComoTextoSiHayQueMandarlo(linea);
      return {
        ...(linea.renglon_id === undefined ? {} : { id: linea.renglon_id }),
        producto_id: linea.producto_id,
        // La bodega del renglón manda; la elegida solo rellena los NUEVOS
        // que se agreguen al corregir, que no traen la suya.
        almacen_id: linea.almacen_id ?? almacenId,
        cantidad_bultos: cantidadComoTexto(linea),
        ...(kilos === null ? {} : { kg_bulto: kilos }),
      };
    }),
  };
}

// ----------------------------------------------------------------- las llamadas

@Injectable({ providedIn: 'root' })
export class NotasApi {
  private readonly http = inject(HttpClient);

  /**
   * Busca clientes para el selector.
   *
   * Con menos de dos caracteres no se busca: el sistema aceptaría uno solo,
   * pero con un carácter devuelve medio catálogo, que es más lento de pintar
   * que de buscar. Dos es el mínimo que distingue ("CL", "PE") sin traerlo
   * todo.
   */
  async clientes(buscar: string): Promise<Cliente[]> {
    if (buscar.trim().length < 2) return [];
    const respuesta = await firstValueFrom(
      this.http.get<Listado<Cliente>>(`${API}/clientes`, {
        params: { buscar: buscar.trim(), limite: 20 },
      }),
    );
    return respuesta.datos;
  }

  /**
   * Busca productos por código o nombre.
   *
   * Aquí un carácter sí sirve: el mostrador tiene lectores de código de
   * barras y el operador teclea "L" y espera, y los productos que empiezan
   * con L son cuatro. Por eso el mínimo aquí es uno y en el de clientes dos.
   */
  async productos(buscar: string): Promise<Producto[]> {
    if (buscar.trim().length < 1) return [];
    const respuesta = await firstValueFrom(
      this.http.get<Listado<Producto>>(`${API}/productos`, {
        params: { buscar: buscar.trim(), limite: 20 },
      }),
    );
    return respuesta.datos;
  }

  /**
   * El precio que se le va a cobrar a ESTE cliente por ESTE producto.
   *
   * Es una consulta por producto que se agrega, y no traer toda la lista de
   * precios de una vez: la regla de que el precio del cliente le gana al de
   * lista es del sistema y la pantalla no la repite. La respuesta trae
   * `vigente: false` cuando el precio existe pero ya pasó su fecha, que es un
   * caso distinto al de "no hay precio" y hay que poder distinguirlos.
   */
  async precio(productoId: number, clienteId: number): Promise<PrecioEfectivo | null> {
    return firstValueFrom(
      this.http.get<PrecioEfectivo | null>(`${API}/precios/efectivo`, {
        params: { producto_id: productoId, cliente_id: clienteId },
      }),
    );
  }

  /**
   * Cuántos bultos hay de un producto en el almacén, como los cuenta el
   * propio sistema (la suma de los movimientos de inventario).
   *
   * Es el "Disponibles" que se ve bajo los bultos de cada renglón. Un `null`
   * es "no se supo" -- el permiso `inventario.ver` no lo tiene la cajera en
   * alguna instalación rara, o la consulta falló -- y la pantalla se queda
   * sin contador, que es mejor que bloquear la captura por saberlo.
   */
  async existencia(productoId: number, almacenId: number): Promise<number | null> {
    try {
      const respuesta = await firstValueFrom(
        this.http.get<Listado<Existencia>>(`${API}/inventario/existencia`, {
          params: { producto_id: productoId, almacen_id: almacenId },
        }),
      );
      const fila = respuesta.datos[0];
      return fila === undefined ? null : fila.existencia_bultos;
    } catch {
      return null;
    }
  }

  /**
   * Las bodegas de las que puede salir la venta.
   *
   * Llenan el selector de la captura. Antes esto era un 1 escrito a mano y si
   * la bodega faltaba el guardado respondía "El almacén 1 no existe": ahora
   * la pantalla ofrece las que hay, y si no hay ninguna, permite crear una en
   * el acto (solo quien tenga `almacenes.crear`).
   */
  async almacenes(): Promise<Almacen[]> {
    const respuesta = await firstValueFrom(this.http.get<{ datos: Almacen[] }>(`${API}/almacenes`));
    return respuesta.datos;
  }

  /**
   * Crea una bodega desde el mismo mostrador.
   *
   * Solo aparece cuando la lista está vacía y quien captura tiene permiso
   * (`almacenes.crear`, del Administrador): con el sistema recién entregado
   * no hay ninguna bodega y la primera venta no se topa con un "almacén 1 no
   * existe". El aviso de nombre repetido (`NOMBRE_DUPLICADO`) lo traduce la
   * pantalla.
   */
  async crearAlmacen(nombre: string): Promise<Almacen> {
    return firstValueFrom(this.http.post<Almacen>(`${API}/almacenes`, { nombre: nombre.trim() }));
  }

  /**
   * Guarda la nota.
   *
   * Devuelve la nota CON SUS RENGLONES y el total que calculó el sistema, y
   * eso es lo que se muestra de aquí en adelante: el total que se ve mientras
   * se captura es un adelanto (ver `totalDeLineas`) y este es el número del
   * documento.
   */
  async crear(cuerpo: CuerpoNota): Promise<Nota> {
    return firstValueFrom(this.http.post<Nota>(`${API}/notas-remision`, cuerpo));
  }

  /**
   * La tabla de notas de abajo del mostrador.
   *
   * `periodo` se manda tal cual y lo resuelve el sistema (ver `Periodo`),
   * porque "hoy" es el día del sistema y no el del reloj del navegador.
   * `buscar` se acepta por folio ("A-1001" o solo "1001") o por nombre del
   * cliente, que son las dos cosas que se teclean en un mostrador.
   */
  async listar(filtro: FiltroNotas): Promise<Listado<NotaListada>> {
    const params: Record<string, string | number> = {
      ordenar: filtro.ordenar,
    };
    if (filtro['periodo'] !== undefined) params['periodo'] = filtro['periodo'];
    if (filtro['buscar'] !== undefined) params['buscar'] = filtro['buscar'];
    if (filtro['fecha_desde'] !== undefined) params['fecha_desde'] = filtro['fecha_desde'];
    if (filtro['fecha_hasta'] !== undefined) params['fecha_hasta'] = filtro['fecha_hasta'];
    if (filtro['limite'] !== undefined) params['limite'] = filtro['limite'];
    if (filtro['offset'] !== undefined) params['offset'] = filtro['offset'];

    return firstValueFrom(this.http.get<Listado<NotaListada>>(`${API}/notas-remision`, { params }));
  }

  /**
   * La nota CON sus renglones: la que se abre al ver una fila de la tabla y
   * la que se carga en el formulario para una devolución.
   *
   * La lista no los trae (traerlos para 50 notas sería pintar 50 tablas), así
   * que abrir una fila o devolver mercancía cuesta una consulta. Es una
   * consulta por cada vez que la persona hace algo con ESA nota, no por nota.
   */
  async consultar(notaId: number): Promise<Nota> {
    return firstValueFrom(this.http.get<Nota>(`${API}/notas-remision/${notaId}`));
  }

  /**
   * Corrige la nota: es la devolución.
   *
   * Manda el detalle COMPLETO, no solo lo que cambió. Eso es lo que el
   * sistema espera: los renglones que no vuelven en la lista se borran (y con
   * ellos vuelve la mercancía al almacén, por la regla automática de
   * inventario) y los que vuelven con id se actualizan. Mandar "solo lo que
   * bajó" haría que cada devolución borrara la nota entera.
   *
   * Devuelve la nota ya recalculada, con el total del sistema: el total que
   * se ve mientras se corrige es un adelanto y este es el del documento.
   */
  async editar(notaId: number, cuerpo: CuerpoEdicion): Promise<Nota> {
    return firstValueFrom(this.http.patch<Nota>(`${API}/notas-remision/${notaId}`, cuerpo));
  }

  /**
   * Cancela la nota, con su motivo.
   *
   * El motivo no es opción: el sistema lo exige (la validación de la
   * actualización 0008) porque una cancelación sin explicación es un botón
   * que borra trabajo. Y cancelar no es lo mismo que devolver: la devolución
   * se hace al corregir la nota.
   */
  async cancelar(notaId: number, motivo: string): Promise<Nota> {
    return firstValueFrom(
      this.http.post<Nota>(`${API}/notas-remision/${notaId}/cancelar`, { motivo }),
    );
  }

  /**
   * Descarga el Excel de la nota.
   *
   * NO se abre en una pestaña como el PDF: un `.xlsx` no lo abre el
   * navegador, y si se le metiera a una ventana nueva se vería como texto o
   * se descargaría a medias. Se baja como archivo con un enlace temporal: se
   * crea, se hace clic y se suelta, sin tocar la página en la que está la
   * persona.
   *
   * Devuelve cuántos renglones se quedaron fuera del papel (la plantilla solo
   * trae 9 espacios): el sistema lo manda junto con el archivo
   * (`X-Renglones-Fuera`), que es lo único que la pantalla puede leer de una
   * respuesta que es un archivo y no datos normales.
   */
  async abrirExcel(notaId: number): Promise<number> {
    const respuesta = await firstValueFrom(
      this.http.get(`${API}/notas-remision/${notaId}/excel`, {
        responseType: 'blob',
        observe: 'response',
      }),
    );

    const url = URL.createObjectURL(respuesta.body as Blob);
    const enlace = document.createElement('a');
    enlace.href = url;
    enlace.download = nombreDelExcel(respuesta.headers.get('content-disposition'));
    enlace.click();
    // El enlace temporal se libera después de un rato, no al cerrar: el clic
    // ya ocurrió y no queda evento al que engancharse. Igual que el PDF.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);

    return Number(respuesta.headers.get('x-renglones-fuera') ?? 0);
  }

  /**
   * Abre el PDF de la nota en una pestaña nueva.
   *
   * NO es un enlace directo al documento, y esa es la diferencia entre que
   * imprima y que no imprima nada: el permiso de la sesión va con cada
   * consulta (ver `nucleo/sesion.ts`), y un enlace plano no lo manda, así que
   * el sistema responde como no autorizado y el operador ve una pantalla en
   * blanco. Por eso se pide el PDF y luego se muestra.
   *
   * Y la ventana se abre ANTES de pedirlo, en blanco, a propósito: después de
   * una espera el navegador ya no sabe que esto viene de un clic y la bloquea
   * como ventana emergente. Con la ventana ya abierta se le pone la dirección
   * cuando llega el PDF, que es lo que sobrevive al bloqueo. Es el orden
   * inverso al intuitivo y por eso está aquí anotado.
   *
   * Un enlace con el permiso a la vista se rechazó a propósito (quedaría en
   * el historial del navegador), así que la única forma de imprimir es esta.
   */
  async abrirPdf(notaId: number): Promise<void> {
    const ventana = window.open('', '_blank');
    if (ventana === null) {
      throw new Error(
        'El navegador no dejó abrir la pestaña. Revisa que no esté bloqueando las ventanas.',
      );
    }

    try {
      const pdf = await firstValueFrom(
        this.http.get(`${API}/notas-remision/${notaId}/pdf`, { responseType: 'blob' }),
      );
      const url = URL.createObjectURL(pdf);
      ventana.location.href = url;
      // El recurso temporal se libera después de un rato, no al cerrar: la
      // ventana ya cambió de documento, así que no hay evento al que
      // engancharse. Sin esto, una sesión de mostrador acumularía un PDF en
      // memoria por cada impresión.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (falla) {
      // La pestana en blanco no se queda abierta: se cierra y el error lo
      // ve la persona en la pantalla, que es donde puede leerlo.
      ventana.close();
      throw falla;
    }
  }

  /**
   * Descarga el Excel de la lista de notas (exportar lista completa).
   *
   * Igual que `abrirExcel`, se baja como archivo con un enlace temporal.
   */
  async exportarExcel(filtro: FiltroNotas): Promise<void> {
    const respuesta = await firstValueFrom(
      this.http.get(`${API}/notas-remision/exportar`, {
        params: {
          ...(filtro.periodo === undefined ? {} : { periodo: filtro.periodo }),
          ...(filtro.buscar === undefined ? {} : { buscar: filtro.buscar }),
          ...(filtro.fecha_desde === undefined ? {} : { fecha_desde: filtro.fecha_desde }),
          ...(filtro.fecha_hasta === undefined ? {} : { fecha_hasta: filtro.fecha_hasta }),
          ordenar: filtro.ordenar,
        },
        responseType: 'blob',
        observe: 'response',
      }),
    );

    const url = URL.createObjectURL(respuesta.body as Blob);
    const enlace = document.createElement('a');
    enlace.href = url;
    enlace.download = nombreDelExcel(respuesta.headers.get('content-disposition'));
    enlace.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  // ------------------------------------------------------- el talonario

  /**
   * Lo que la pantalla usará para su siguiente folio: la serie activa.
   *
   * Esta es la preferencia que dejó puesta quien administra el talonario
   * (`notas.folios`). Vacía significa folios de puros números, el formato
   * normal del negocio.
   */
  async serieActiva(): Promise<string> {
    const respuesta = await firstValueFrom(
      this.http.get<{ serie: string }>(`${API}/notas-remision/folios/serie-activa`),
    );
    return respuesta.serie;
  }

  /** Guarda la serie activa. La preferencia se reemplaza entera. */
  async ponerSerieActiva(serie: string): Promise<string> {
    const respuesta = await firstValueFrom(
      this.http.put<{ serie: string }>(`${API}/notas-remision/folios/serie-activa`, { serie }),
    );
    return respuesta.serie;
  }

  /**
   * Un renglón por serie, para la tabla del talonario.
   *
   * No pinta los cientos de folios de una serie: pinta la serie y lo que
   * tiene libre, que es lo que decide si se puede activar. Los folios sueltos
   * de una serie se piden con `listarFolios`.
   */
  async resumenDeTalonarios(): Promise<ResumenTalonario[]> {
    return firstValueFrom(
      this.http.get<ResumenTalonario[]>(`${API}/notas-remision/folios/resumen`),
    );
  }

  /** Los folios de una serie, para ver los números que la componen. */
  async listarFolios(filtro: {
    serie?: string;
    limite: number;
    offset: number;
  }): Promise<Listado<Folio>> {
    return firstValueFrom(
      this.http.get<Listado<Folio>>(`${API}/notas-remision/folios`, {
        params: {
          ...(filtro.serie === undefined ? {} : { serie: filtro.serie }),
          limite: filtro.limite,
          offset: filtro.offset,
        },
      }),
    );
  }

  /**
   * Carga un tramo de talonario, del `desde` al `hasta` inclusive.
   *
   * `serie` es el PREFIJO de esos folios y puede ir vacío: vacío = folios de
   * puros números. El formato lo decide la persona al cargar el tramo, no el
   * código.
   */
  async crearTalonario(
    cuerpo: CuerpoTalonario,
  ): Promise<{ creados: number; omitidos: number; primero: number; ultimo: number }> {
    return firstValueFrom(
      this.http.post<{ creados: number; omitidos: number; primero: number; ultimo: number }>(
        `${API}/notas-remision/folios`,
        cuerpo,
      ),
    );
  }

  async eliminar(id: number): Promise<void> {
    await firstValueFrom(this.http.delete(`${API}/notas-remision/${id}`));
  }
}

/**
 * El nombre del archivo que puso el sistema, sin la parte técnica que lo
 * envuelve.
 *
 * El sistema anota el nombre junto con el archivo y ese es el que debe usar
 * el enlace de descarga. Si no viene o viene raro, se devuelve uno fijo: que
 * la descarga salga vale más que el nombre.
 */
function nombreDelExcel(contentDisposition: string | null): string {
  const nombre = /filename="([^"]+)"/.exec(contentDisposition ?? '')?.[1];
  return nombre ?? 'nota-remision.xlsx';
}
