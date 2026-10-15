import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { API, descargarExcel } from '../nucleo/api';

/**
 * El servicio de proveedores.
 *
 * Es el módulo más pequeño del proyecto: nombre, contacto, teléfono y nada
 * más. Tres cosas que no se ven en los tipos pero sí en las reglas:
 *
 *   - `saldo_actual` se LEE y nunca se manda. Lo mantiene
 *     `fn_recalcular_saldo_proveedor` sumando las compras y los pagos al
 *     proveedor; aceptarlo al crear abriría la puerta a cuadrar a mano lo que
 *     el sistema recalcula solo. Por eso no está en `CuerpoProveedor`.
 *   - No hay borrar. La baja es `activo: false`, y por eso el formulario NO
 *     tiene una casilla de "activo": el alta no la acepta
 *     (`crearProveedorEsquema` no admite campos de más) y el estado se cambia
 *     desde la fila.
 *   - El `nombre` es único en el sistema y el servicio responde
 *     `PROVEEDOR_DUPLICADO` antes de llegar a esa validación, para que el
 *     mensaje diga que ya existe ese proveedor.
 *
 * La forma de la lista es `{ datos, total, limite, offset }`
 * (`proveedores/servicio.ts`), como productos; clientes manda el total anidado
 * en `paginación` y cada pantalla define la suya.
 */

// --------------------------------------------------------------------- tipos

/**
 * `proveedores/modelo.ts` -> `Proveedor`.
 *
 * Es lo que devuelven el alta, la edición y la consulta del detalle. El
 * listado trae una cosa más (`compras`), y por eso son dos tipos y no uno con
 * un opcional: `compras` es un conteo de la fila, no una columna del
 * proveedor.
 */
export interface Proveedor {
  id: number;
  nombre: string;
  contacto: string | null;
  telefono: string | null;
  saldo_actual: number;
  activo: boolean;
  creado_en: string;
}

/** La fila del listado: el proveedor y cuantas compras tiene. */
export interface ProveedorListado extends Proveedor {
  /**
   * Cuántas compras tiene el proveedor.
   *
   * El conteo es del servicio y no filtra por estatus (`proveedores/
   * repositorio.ts`), así que incluye las canceladas: sirve para saber si el
   * proveedor tiene historial —y por eso no se borra, se da de baja—, no para
   * cuadrar cuentas.
   */
  compras: number;
}

/** La envoltura del listado (`proveedores/servicio.ts`). */
export interface ListaProveedores {
  datos: ProveedorListado[];
  total: number;
  limite: number;
  offset: number;
}

/** La forma del editor: lo que se teclea, sin normalizar. */
export interface FormaProveedor {
  nombre: string;
  contacto: string;
  telefono: string;
}

/**
 * Los datos al crear o actualizar un proveedor.
 *
 * No lleva `activo` ni `saldo_actual`: el estado va aparte en `actualizar`
 * (ver ahí) y el saldo no se manda nunca.
 */
export interface CuerpoProveedor {
  nombre: string;
  contacto: string | null;
  telefono: string | null;
}

/**
 * La forma del editor convertida a los datos que se mandan.
 *
 * El nombre se manda limpio de los bordes porque es la LLAVE del proveedor en
 * cualquier parte del sistema: es como lo busca el operador al capturar una
 * compra y como aparece impreso. Los dos opcionales en blanco viajan como
 * `null` y no como `''`, que es como los guarda el sistema: sin dato, no un
 * texto de espacios.
 */
export function cuerpoDeProveedor(forma: FormaProveedor): CuerpoProveedor {
  return {
    nombre: forma.nombre.trim(),
    contacto: textoONull(forma.contacto),
    telefono: textoONull(forma.telefono),
  };
}

function textoONull(valor: string): string | null {
  const limpio = valor.trim();
  return limpio === '' ? null : limpio;
}

// ----------------------------------------------------------------- el cuerpo

@Injectable({ providedIn: 'root' })
export class ProveedoresApi {
  private readonly http = inject(HttpClient);

  /**
   * Lista con búsqueda, filtro de estado y paginación.
   *
   * El filtro tiene tres estados porque el sistema solo sabe decir
   * `activo: true` o `activo: false` (`listarProveedoresEsquema`), y "todos"
   * es no mandar el parámetro. Por omisión salen solo los ACTIVOS: un
   * proveedor dado de baja no debe salir en el selector de la compra, y esa es
   * la pregunta que se hace el 99% de las veces; quien lo busca dado de baja
   * lo cambia en el desplegable.
   */
  async listar(opciones: {
    buscar?: string;
    activo?: 'todos' | 'activos' | 'inactivos';
    limite?: number;
    offset?: number;
  }): Promise<ListaProveedores> {
    const params: Record<string, string | number> = {
      limite: opciones.limite ?? 50,
      offset: opciones.offset ?? 0,
    };
    if (opciones.buscar) params['buscar'] = opciones.buscar;
    if (opciones.activo === 'activos') params['activo'] = 'true';
    if (opciones.activo === 'inactivos') params['activo'] = 'false';
    return firstValueFrom(this.http.get<ListaProveedores>(`${API}/proveedores`, { params }));
  }

  /** Crea. 201 + el proveedor con su id. */
  async crear(cuerpo: CuerpoProveedor): Promise<Proveedor> {
    return firstValueFrom(this.http.post<Proveedor>(`${API}/proveedores`, cuerpo));
  }

  /**
   * Edita.
   *
   * `activo` va APARTE y es opcional porque las reglas de crear no lo aceptan:
   * mandarlo en el alta sería un campo que las reglas de validación del alta
   * rechazan con un 400. Por eso el editor no lo manda y la baja se alterna
   * desde la fila con `alternarActivo`.
   */
  async actualizar(id: number, cuerpo: CuerpoProveedor, activo?: boolean): Promise<Proveedor> {
    const parche: Partial<CuerpoProveedor> & { activo?: boolean } = { ...cuerpo };
    if (activo !== undefined) parche.activo = activo;
    return firstValueFrom(this.http.patch<Proveedor>(`${API}/proveedores/${id}`, parche));
  }

  /**
   * Da de baja o reactiva, sin abrir el editor.
   *
   * Es una actualización de un solo campo a propósito: el servicio del
   * sistema arma la actualización campo por campo
   * (`proveedores/repositorio.ts`), así que mandando solo `activo` no se puede
   * tocar por accidente el nombre o el teléfono de un proveedor que ya tiene
   * compras encima.
   */
  async alternarActivo(id: number, activo: boolean): Promise<Proveedor> {
    return firstValueFrom(this.http.patch<Proveedor>(`${API}/proveedores/${id}`, { activo }));
  }

  /**
   * Exporta a Excel lo que hay FILTRADO, no la página que se ve.
   *
   * Los filtros se mandan tal cual y sin `limite`/`offset`: el sistema tiene su
   * propia forma de exportar sin paginación para esto, así que el archivo sale
   * entero aunque en la pantalla se esté viendo la segunda de tres páginas.
   * Por eso está fuera de `listar()` y no es un `listar` con otros parámetros.
   */
  async exportarExcel(filtro: {
    buscar?: string;
    activo?: 'todos' | 'activos' | 'inactivos';
  }): Promise<void> {
    const params: Record<string, string> = {};
    if (filtro.buscar) params['buscar'] = filtro.buscar;
    if (filtro.activo === 'activos') params['activo'] = 'true';
    if (filtro.activo === 'inactivos') params['activo'] = 'false';

    const respuesta = await firstValueFrom(
      this.http.get(`${API}/proveedores/exportar`, {
        params,
        responseType: 'blob',
        observe: 'response',
      }),
    );
    descargarExcel(respuesta, 'proveedores.xlsx');
  }
}
