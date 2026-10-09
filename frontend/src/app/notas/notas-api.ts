import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { API } from '../nucleo/api';
import { cantidadComoTexto, kgComoTextoSiHayQueMandarlo, type Linea } from './linea';

/**
 * La API del mostrador: clientes, productos, precios y el alta de la nota.
 *
 * Los tipos de aqui son un espejo de los del backend. No se comparten
 * (el front y el back son dos paquetes y no hay un monorepo), asi que
 * cuando cambie una forma hay que cambiar el tipo de este archivo; por eso
 * cada uno lleva el archivo del backend del que salio.
 *
 * No hay ningun `subscribe` en las pantallas: todo se resuelve con
 * `firstValueFrom` y `await`. Un mostrador son clics sueltos, no un
 * formulario con muchos campos a la vez, y el estado de "guardando" se
 * maneja con una signal.
 */

// --------------------------------------------------------------------- tipos

/** `clientes/modelo.ts` -> `Cliente`. El POS usa el id, el nombre y el rfc. */
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
  /** `false` cuando el precio existe pero ya vencio: hay que decirlo. */
  vigente: boolean;
  origen: 'cliente' | 'publico' | null;
  precio_id: number | null;
  precio_kg: number | null;
  vigente_desde: string | null;
  vigente_hasta: string | null;
}

/** `inventario/modelo.ts` -> `Existencia`. El POS usa solo `existencia_bultos`. */
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
 * `notas-remision/modelo.ts` -> `NotaListada`: la fila de la tabla de abajo.
 *
 * NO trae los renglones (traerlos para 50 notas seria pintar 50 tablas
 * enteras), solo cuantos tiene. El detalle se pide con `consultar` cuando la
 * persona abre una fila.
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
  /** Los kilos que salen en el camion, sumados de los renglones. */
  kg_total: number;
}

/**
 * El periodo del listado. `hoy` y `ultimos_7` los resuelve la BASE
 * (`periodosEsquema` en `notas-remision/esquemas.ts`), no el navegador: la
 * fecha de una nota la decide `CURRENT_DATE` del servidor de la base, y un
 * filtro armado con la fecha del navegador deja fuera la nota que se acaba de
 * capturar cuando la maquina del mostrador y el servidor estan en dias
 * distintos.
 *
 * `'todo'` no existe en el backend: es la ausencia de filtro, y se manda
 * `undefined`.
 */
export type Periodo = 'hoy' | 'ultimos_7';

/**
 * Como se pide el listado ordenado. Son las cuatro combinaciones que ofrece el
 * desplegable de la pantalla, y son las UNICAS que el backend acepta: el
 * esquema del servidor es un enum y no un campo libre, para que nadie pueda
 * pedir un orden sin indice.
 */
export type OrdenNotas = 'fecha_desc' | 'fecha_asc' | 'subtotal_desc' | 'subtotal_asc';

/** Lo que el desplegable muestra, y a que valor del backend corresponde. */
export const ORDENES_NOTAS: { valor: OrdenNotas; texto: string }[] = [
  { valor: 'fecha_desc', texto: 'Mas recientes primero' },
  { valor: 'fecha_asc', texto: 'Mas antiguas primero' },
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

/** La envoltura de los listados. `notas-remision/modelo.ts` -> `Listado`. */
export interface Listado<T> {
  datos: T[];
  total: number;
  limite: number;
  offset: number;
}

/** `notas-remision/modelo.ts` -> `Folio`: un numero del talonario. */
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

/** El cuerpo de `POST /folios`: un tramo de talonario. */
export interface CuerpoTalonario {
  serie: string;
  desde: number;
  hasta: number;
}

// ------------------------------------------------------------------ el cuerpo

/**
 * El cuerpo de `POST /api/notas-remision`, tal como lo quiere
 * `crearNotaEsquema`.
 *
 * Lo que se ve aqui, y no en la pantalla, es lo que decides NO mandar:
 *
 *   - `serie`: NO se manda. El talonario del que sale el folio es la
 *     "serie activa" que dejo puesta quien administra `notas.folios`
 *     (endpoint `PUT /folios/serie-activa`), y el backend la resuelve si
 *     el cuerpo no la trae. El mostrador no debe saber que serie es la de
 *     hoy: eso cambio en la oficina, no en el mostrador.
 *   - `subtotal`: NO existe. Es una columna GENERATED y el esquema es
 *     `strict`, asi que mandarla da un 400 con un mensaje en ingles sobre
 *     "cannot insert into column". Es el 400 mas confuso de toda la API.
 *   - `precio_unit_kg`: NO se manda, aunque la pantalla ya sepa el
 *     precio. El backend lo resuelve en la FECHA DE LA NOTA si no llega
 *     (`prepararRenglones` -> `resolverEfectivo`), que es la regla del
 *     negocio; mandarlo desde la pantalla abriria la puerta a que un
 *     `precio_unit_kg: 0.01` en el JSON cobre un peso. El precio que se
 *     ve en la linea es el mismo que va a resolver el servidor con la misma
 *     fecha y el mismo cliente.
 *   - `fecha`: NO se manda, y por lo mismo: si no viene, la usa la base
 *     (`hoyEnLaBase`). Mandarla desde el navegador es como la fecha se
 *     corre un dia en un huso horario.
 *   - `kg_bulto`: solo si la persona lo toco. Si no, lo rellena
 *     `fn_default_kg_bulto` con `productos.presentacion_kg`, que es la
 *     presentacion real del producto y no la que el navegador recuerda.
 *   - `id`: los renglones del alta no tienen id en la base todavia.
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
 * El cuerpo de `PATCH /api/notas-remision/:id`, tal como lo quiere
 * `editarNotaEsquema`.
 *
 * Tres diferencias con el del alta, y las tres son obligatorias:
 *
 *   - `renglones[].id`: sin el, el backend no puede distinguir "este renglon
 *     ya estaba" de "este es nuevo", y cada guardado borraria todos los
 *     renglones y los volveria a crear. Con los renglones borrados y
 *     recreados, sus movimientos de inventario tambien se borran y se
 *     rehacen: una devolucion terminaria con el kardoex lleno de ruido.
 *     Los que la persona quito de la tabla (una devolucion completa) no
 *     vienen, y el backend los borra de verdad.
 *   - `almacen_id`: se toma del renglon (`RenglonNota.almacen_id`). En el
 *     alta la nota es nueva y la bodega la elige la pantalla; al corregir una
 *     nota, el producto puede haber salido de otra bodega, y mandarle el
 *     almacen equivocado descuenta el stock de la que no es. La bodega de la
 *     pantalla solo rellena los renglones NUEVOS que se agreguen.
 *   - `precio_unit_kg`: tampoco se manda, y por la misma razon que en el
 *     alta. El backend conserva el precio de los renglones que ya estaban
 *     (ver `prepararRenglones` -> `aConservar` en el servicio), que es lo
 *     que se cobro. Bajar bultos en una devolucion no puede cambiar el
 *     precio por kilo de lo que quedo.
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
 * El almacen del que sale la venta.
 *
 * `almacenes.id` es un SMALLINT y el catalogo se sirve por `/api/almacenes`
 * (`catalogo/`), el mismo modulo que especies y categorias. La pantalla lo
 * elige en la captura y lo pasa aqui por parametro: ya no hay un 1 escrito a
 * mano, y si no hay bodega el guardado se bloquea ANTES de llegar al backend
 * en vez de responder "El almacen 1 no existe".
 *
 * En el ALTA la bodega es una sola para toda la nota. En la EDICION cada
 * renglon conserva la suya (`RenglonNota.almacen_id`): el producto puede
 * haber salido de otra bodega, y mandarle el almacen equivocado descuenta el
 * stock de la que no es. La bodega elegida solo rellena los renglones NUEVOS
 * que se agreguen al corregir.
 */
export interface Almacen {
  id: number;
  nombre: string;
}

/** Arma el cuerpo de la nota. */
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

  // La direccion es opcional y vacia no es lo mismo que ninguna: se manda
  // `null` para BORRAR la que tuviera, y para eso el esquema la acepta
  // nullable. Sin esto, una nota editada nunca podria quedar sin direccion.
  const limpia = direccion?.trim();
  if (limpia) cuerpo.direccion_entrega = limpia;

  return cuerpo;
}

/**
 * Arma el cuerpo de la edicion (la devolucion).
 *
 * A diferencia del alta, aqui la direccion se manda SIEMPRE, aunque venga
 * vacia: `editarNotaEsquema` trata `direccion_entrega` como lo que es, un
 * campo que se puede dejar en null, y mandarlo solo cuando hay texto hacia
 * que quitar la direccion que la nota tenia y no se puede quitar. En el alta
 * no hay nada que quitar (la nota no existia), asi que alli si vale la regla
 * de "solo si hay algo".
 */
export function cuerpoDeEdicion(
  clienteId: number,
  lineas: Linea[],
  almacenId: number,
  direccion: string,
): CuerpoEdicion {
  if (lineas.length === 0) {
    // Un renglon de menos es una devolucion; una nota sin renglones es un
    // documento que no existe. Cancelarla es otra cosa y tiene otro boton.
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
        // La bodega del renglon manda; la elegida solo rellena los NUEVOS
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
   * `buscar` con menos de dos caracteres no se manda: el backend acepta
   * uno solo (`min(1)`) y con un caracter devuelve medio catalogo, que es
   * mas lento de pintar que de buscar. Dos es el minimo que discrimina
   * ("CL", "PE") sin traer el mundo.
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
   * Busca productos por codigo o nombre.
   *
   * Aqui un caracter si sirve: el mostrador tiene lectores de codigo de
   * barras y el operador Teclea "L" y espera, y un producto que empiece con
   * L son cuatro. Por eso el minimo aqui es uno y en el de clientes dos.
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
   * Es una llamada por producto que se agrega, y no un catalogo de precios
   * de una vez: la precedencia (el del cliente le gana al de lista) es
   * regla del backend y el POS no la reimplementa. La respuesta trae
   * `vigente: false` cuando el precio existe pero ya paso su fecha, que es
   * un caso distinto al de "no hay precio" y hay que poder distinguirlos.
   */
  async precio(productoId: number, clienteId: number): Promise<PrecioEfectivo | null> {
    return firstValueFrom(
      this.http.get<PrecioEfectivo | null>(`${API}/precios/efectivo`, {
        params: { producto_id: productoId, cliente_id: clienteId },
      }),
    );
  }

  /**
   * Cuantos bultos hay de un producto en el almacen, como los cuenta la
   * propia base (la suma de los movimientos de inventario).
   *
   * Es el "Disponibles" que se ve bajo los bultos de cada renglon. Un
   * `null` es "no se supo" -- el permiso `inventario.ver` no es de la
   * cajera en alguna base rara, o la consulta fallo -- y la pantalla se
   * queda sin contador, que es mejor que bloquear la captura por saberlo.
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
   * la bodega faltaba el guardado respondia "El almacen 1 no existe": ahora
   * la pantalla ofrece las que hay, y si no hay ninguna, crear una en el acto
   * (solo quien tenga `almacenes.crear`).
   */
  async almacenes(): Promise<Almacen[]> {
    const respuesta = await firstValueFrom(this.http.get<{ datos: Almacen[] }>(`${API}/almacenes`));
    return respuesta.datos;
  }

  /**
   * Crea una bodega desde el mismo mostrador.
   *
   * Solo aparece cuando la lista esta vacia y quien captura tiene permiso
   * (`almacenes.crear`, del Administrador): con el sistema recien entregado
   * la base va limpia y la primera venta no se topa con un "almacen 1 no
   * existe". El 409 `NOMBRE_DUPLICADO` lo traduce la pantalla en su aviso.
   */
  async crearAlmacen(nombre: string): Promise<Almacen> {
    return firstValueFrom(this.http.post<Almacen>(`${API}/almacenes`, { nombre: nombre.trim() }));
  }

  /**
   * Guarda la nota.
   *
   * Devuelve la nota CON SUS RENGLONES y el `subtotal` que calculo la base,
   * y eso es lo que se muestra de aqui en adelante: el total que se ve
   * mientras se captura es un preview (ver `totalDeLineas`) y este es el
   * numero del documento.
   */
  async crear(cuerpo: CuerpoNota): Promise<Nota> {
    return firstValueFrom(this.http.post<Nota>(`${API}/notas-remision`, cuerpo));
  }

  /**
   * La tabla de notas de abajo del mostrador.
   *
   * `periodo` viaja tal cual y lo resuelve la base (ver `Periodo`), porque
   * "hoy" es el dia de la base y no el del reloj del navegador. `buscar` lo
   * acepta el backend por folio ("A-1001" o solo "1001") o por nombre del
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
   * la que se carga en el formulario para una devolucion.
   *
   * El listado no las trae (traerlas para 50 notas seria pintar 50 tablas),
   * asi que abrir una fila o devolver mercancia cuesta una llamada. Es una
   * llamada por cada vez que la persona hace algo con ESA nota, no por nota.
   */
  async consultar(notaId: number): Promise<Nota> {
    return firstValueFrom(this.http.get<Nota>(`${API}/notas-remision/${notaId}`));
  }

  /**
   * Corrige la nota: es la devolucion.
   *
   * Manda el detalle COMPLETO, no solo lo que cambio. Es lo que espera
   * `editarNotaEsquema` y lo que hace el backend: los renglones que no
   * vuelven en el arreglo se borran (y con ellos vuelve la mercancia al
   * almacen, por el trigger de inventario) y los que vuelven con id se
   * actualizan. Mandar "solo lo que bajo" haria que cada devolucion borrara
   * la nota entera.
   *
   * Devuelve la nota ya recalculada, con el `subtotal` de la base: el total
   * que se ve mientras se corrige es un preview y este es el del documento.
   */
  async editar(notaId: number, cuerpo: CuerpoEdicion): Promise<Nota> {
    return firstValueFrom(this.http.patch<Nota>(`${API}/notas-remision/${notaId}`, cuerpo));
  }

  /**
   * Cancela la nota, con su motivo.
   *
   * El motivo no es opcion: el backend lo exige (el CHECK
   * `chk_notas_motivo_cancelacion` de la migracion 0008) porque una
   * cancelacion sin explicacion es un boton que borra trabajo. Y cancelar no
   * es lo mismo que devolver: la devolucion es `editar`.
   */
  async cancelar(notaId: number, motivo: string): Promise<Nota> {
    return firstValueFrom(
      this.http.post<Nota>(`${API}/notas-remision/${notaId}/cancelar`, { motivo }),
    );
  }

  /**
   * Descarga el Excel de la nota.
   *
   * NO se abre en una pestana como el PDF: un `.xlsx` no lo abre el
   * navegador, y si se le metiera a una ventana nueva se veria como texto
   * o se descargaria a medias. Va como `attachment` desde el backend, y
   * aqui se baja como archivo con un `<a download>` temporal: se crea, se
   * hace clic y se suelta, sin tocar la pagina en la que esta la persona.
   *
   * Devuelve cuantos renglones se quedaron fuera del papel (la plantilla
   * solo trae 9 bloques): el backend lo manda en la cabecera
   * `X-Renglones-Fuera`, que es lo unico que el frontend puede leer de una
   * respuesta que es un archivo, no JSON.
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
    // El object URL se revaca con tiempo, no al cerrar: el anchor ya tuvo
    // su clic y no queda evento al que engancharse. Igual que el PDF.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);

    return Number(respuesta.headers.get('x-renglones-fuera') ?? 0);
  }

  /**
   * Abre el PDF de la nota en una pestana nueva.
   *
   * NO es un `<a href>` al endpoint, y esa es la diferencia entre que
   * imprima y que no imprima nada: el token va en la cabecera
   * `Authorization` (ver `nucleo/sesion.ts`), y un link plano no manda
   * cabeceras, asi que el backend responde 401 y el operador ve una pantalla
   * en blanco. Por eso se pide el PDF como blob.
   *
   * Y la ventana se abre ANTES de pedirlo, en blanco, a proposito: despues
   * de un `await` el navegador ya no sabe que esto viene de un click y la
   * bloquea como ventana emergente. Con la ventana ya abierta se le pone la
   * direccion cuando llega el PDF, que es lo que sobrevive al bloqueo. Es
   * el orden inverso al intuitivo y por eso esta aqui anotado.
   *
   * Un link con el token en el query se rechazo a proposito en el backend
   * (quedaria en el historial del navegador y en el log del proxy), asi que
   * la unica forma de imprimir es esta.
   */
  async abrirPdf(notaId: number): Promise<void> {
    const ventana = window.open('', '_blank');
    if (ventana === null) {
      throw new Error(
        'El navegador no dejo abrir la pestana. Revisa que no este bloqueando las ventanas.',
      );
    }

    try {
      const pdf = await firstValueFrom(
        this.http.get(`${API}/notas-remision/${notaId}/pdf`, { responseType: 'blob' }),
      );
      const url = URL.createObjectURL(pdf);
      ventana.location.href = url;
      // El object URL se revaca con tiempo, no al cerrar: la ventana ya
      // cambio de documento al navegar al blob, asi que no hay evento al
      // que engancharse. Sin esto, una sesion de mostrador acumula un PDF
      // en memoria por cada impresion.
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
   * Igual que `abrirExcel`, se baja como `attachment` con `<a download>`.
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
   * Lo que el POS usara para su siguiente folio: la serie activa.
   *
   * Esta es la preferencia que dejo puesta quien administra el talonario
   * (`notas.folios`). Vacua significa folios de puros numeros, el formato
   * normal del negocio.
   */
  async serieActiva(): Promise<string> {
    const respuesta = await firstValueFrom(
      this.http.get<{ serie: string }>(`${API}/notas-remision/folios/serie-activa`),
    );
    return respuesta.serie;
  }

  /** Guarda la serie activa. Nada de `PATCH`: la preferencia se pisa entera. */
  async ponerSerieActiva(serie: string): Promise<string> {
    const respuesta = await firstValueFrom(
      this.http.put<{ serie: string }>(`${API}/notas-remision/folios/serie-activa`, { serie }),
    );
    return respuesta.serie;
  }

  /**
   * Un renglon por serie, para la tabla del talonario.
   *
   * No pinta los cientos de folios de una serie: pinta la serie y lo que
   * tiene libre, que es lo que decide si se puede activar. Los folios
   * sueltos de una serie se piden con `listarFolios`.
   */
  async resumenDeTalonarios(): Promise<ResumenTalonario[]> {
    return firstValueFrom(
      this.http.get<ResumenTalonario[]>(`${API}/notas-remision/folios/resumen`),
    );
  }

  /** Los folios de una serie, para ver los numeros que la componen. */
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
   * `serie` es el PREFIJO de esos folios y puede ir vacio: vacio = folios
   * de puros numeros. El formato lo decide la persona al cargar el tramo,
   * no el codigo.
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
}

/**
 * El nombre del archivo que el backend puso en `Content-Disposition`, sin
 * la envoltura de cabecera.
 *
 * `Content-Disposition` va como
 * `attachment; filename="nota-remision-A-1001-2026-09-27.xlsx"` y el nombre
 * es lo que el `<a download>` debe usar. Si la cabecera no viene o viene
 * rara, se devuelve uno fijo: que la descarga salga vale mas que el nombre.
 */
function nombreDelExcel(contentDisposition: string | null): string {
  const nombre = /filename="([^"]+)"/.exec(contentDisposition ?? '')?.[1];
  return nombre ?? 'nota-remision.xlsx';
}
