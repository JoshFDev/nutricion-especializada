import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { API, descargarExcel } from '../nucleo/api';

/**
 * La API de proveedores.
 *
 * Es el espejo de `backend/src/modules/proveedores`, y el módulo más pequeño
 * del proyecto: nombre, contacto, teléfono y nada más. Tres cosas que no se
 * ven en los tipos pero si en las reglas:
 *
 *   - `saldo_actual` se LEE y nunca se manda. Lo mantiene
 *     `fn_recalcular_saldo_proveedor` sumando las compras y los pagos al
 *     proveedor; aceptarlo en el POST abriría la puerta a cuadrar a mano lo
 *     que la base recalcula sola. Por eso no esta en `CuerpoProveedor`.
 *   - No hay DELETE. La baja es `activo: false` por PATCH, y por eso el
 *     formulario NO tiene una casilla de "activo": el alta no la acepta
 *     (`crearProveedorEsquema` es `strict` y no la tiene) y el estado se
 *     cambia desde la fila.
 *   - El `nombre` es UNIQUE en la base y el servicio responde
 *     `PROVEEDOR_DUPLICADO` antes de llegar al UNIQUE, para que el mensaje
 *     diga que ya existe ese proveedor.
 *
 * La envoltura de la lista es `{ datos, total, limite, offset }`
 * (`proveedores/servicio.ts`), como productos; clientes manda el total
 * anidado en `paginación` y cada pantalla define la suya.
 */

// --------------------------------------------------------------------- tipos

/**
 * `proveedores/modelo.ts` -> `Proveedor`.
 *
 * Es lo que devuelven el alta, la edicion y `GET /:id`. El listado trae una
 * cosa más (`compras`), y por eso son dos tipos y no uno con un opcional:
 * `compras` es un conteo de la fila, no una columna del proveedor.
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
   * Cuantas compras tiene el proveedor.
   *
   * El conteo es del repositorio y no filtra por estatus (`proveedores/
   * repositorio.ts`), así que incluye las canceladas: sirve para saber si el
   * proveedor tiene historial —y por eso no se borra, se da de baja—, no
   * para cuadrar cuentas.
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
 * El cuerpo de `POST/PATCH /api/proveedores`.
 *
 * No lleva `activo` ni `saldo_actual`: el estado va aparte en `actualizar`
 * (ver ahi) y el saldo no se manda nunca.
 */
export interface CuerpoProveedor {
  nombre: string;
  contacto: string | null;
  telefono: string | null;
}

/**
 * La forma del editor convertida al cuerpo de la peticion.
 *
 * El nombre se manda limpio de los bordes porque es la LLAVE del proveedor
 * en cualquier parte del sistema: es como lo busca el operador al capturar
 * una compra y como aparece impreso. Los dos opcionales en blanco viajan
 * como `null` y no como `''`, que es como los guarda la base: sin dato, no
 * un string de espacios.
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
   * El filtro tiene tres estados porque el backend solo sabe decir
   * `activo: true` o `activo: false` (`listarProveedoresEsquema`), y "todos"
   * es no mandar el parametro. Por omision salen solo los ACTIVOS: un
   * proveedor dado de baja no debe salir en el selector de la compra, y esa
   * es la pregunta que se hace el 99% de las veces; el que lo busca dado de
   * baja lo cambia en el desplegable.
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
   * `activo` va APARTE del cuerpo y es opcional porque el esquema de crear
   * no lo acepta: mandarlo en el alta sería un campo que el `strict` del
   * `POST` rechaza con un 400. Por eso el editor no lo manda y la baja se
   * alterna desde la fila con `alternarActivo`.
   */
  async actualizar(id: number, cuerpo: CuerpoProveedor, activo?: boolean): Promise<Proveedor> {
    const parche: Partial<CuerpoProveedor> & { activo?: boolean } = { ...cuerpo };
    if (activo !== undefined) parche.activo = activo;
    return firstValueFrom(this.http.patch<Proveedor>(`${API}/proveedores/${id}`, parche));
  }

  /**
   * Da de baja o reactiva, sin abrir el editor.
   *
   * Es un PATCH de un solo campo a proposito: el repositorio del backend
   * arma el `UPDATE` campo por campo (`proveedores/repositorio.ts`), así que
   * mandando solo `activo` no se puede tocar por accidente el nombre o el
   * teléfono de un proveedor que ya tiene compras encima.
   */
  async alternarActivo(id: number, activo: boolean): Promise<Proveedor> {
    return firstValueFrom(this.http.patch<Proveedor>(`${API}/proveedores/${id}`, { activo }));
  }

  /**
   * Exporta a Excel lo que hay FILTRADO, no la página que se ve.
   *
   * Los filtros se mandan tal cuál y sin `limite`/`offset`: el backend tiene
   * su propia ruta sin paginación para esto, así que el archivo sale entero
   * aunque en la pantalla se esté viendo la segunda de tres páginas. Por eso
   * esta fuera de `listar()` y no es un `listar` con otros parámetros.
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
