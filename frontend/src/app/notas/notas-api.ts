import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { API } from '../nucleo/api';
import { cantidadComoTexto, kilosComoTextoSiEditados, type Linea } from './linea';

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

/** `notas-remision/modelo.ts` -> `Renglon`. */
export interface RenglonNota {
  id: number;
  producto_id: number;
  producto_codigo: string;
  producto_nombre: string;
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
  vendedor: string | null;
  fecha: string;
  direccion_entrega: string | null;
  subtotal: number;
  estatus: 'pendiente' | 'parcial' | 'pagada' | 'cancelada';
  renglones: RenglonNota[];
}

/** La envoltura de los listados. `notas-remision/modelo.ts` -> `Listado`. */
export interface Listado<T> {
  datos: T[];
  total: number;
  limite: number;
  offset: number;
}

// ------------------------------------------------------------------ el cuerpo

/**
 * El cuerpo de `POST /api/notas-remision`, tal como lo quiere
 * `crearNotaEsquema`.
 *
 * Lo que se ve aqui, y no en la pantalla, es lo que decides NO mandar:
 *
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
  serie: string;
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
 * El almacen del que sale la venta.
 *
 * `almacenes.id` es un SMALLINT y no hay endpoint de almacenes todavia (no
 * hay un modulo de almacenes en la API). La semilla crea una sola bodega y
 * el POS vende de ahi.
 *
 * Es lo unico del POS que esta escrito a mano, y es el primer lugar donde
 * hay que tocar cuando se carguen mas de una: o llega el endpoint de
 * almacenes y esta constante se sustituye por el almacen que elija la
 * persona, o se deja asi y se admite que solo hay una bodega. Lo que no
 * puede ser es que quede en un 1 sin que nadie lo sepa, porque el dia que
 * haya dos bodegas la segunda vende de la primera sin avisar.
 */
export const ALMACEN_ID = 1;

/**
 * La serie del talonario de donde sale el folio.
 *
 * La serie no se elige en esta pantalla a proposito: `crear()` toma el
 * folio mas bajo disponible de la SERIE que le pidan, con candado, y por
 * eso el numero no lo escribe el operador (dos personas cobrando a la vez
 * podrian pedir el mismo). La semilla carga los folios 1001-1003 en la
 * serie 'A', que es el DEFAULT de la tabla `folios`.
 *
 * Cuando exista la pantalla del talonario (`notas.folios`), elijan la
 * persona y esto se quita.
 */
export const SERIE = 'A';

/** Arma el cuerpo de la nota. */
export function cuerpoDeNota(
  clienteId: number,
  lineas: Linea[],
  direccion?: string | null,
): CuerpoNota {
  if (lineas.length === 0) {
    throw new Error('Una nota necesita al menos un renglon');
  }

  const cuerpo: CuerpoNota = {
    cliente_id: clienteId,
    serie: SERIE,
    renglones: lineas.map((linea) => {
      const kilos = kilosComoTextoSiEditados(linea);
      return {
        producto_id: linea.producto_id,
        almacen_id: ALMACEN_ID,
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
