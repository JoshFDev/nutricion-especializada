import { HttpErrorResponse, type HttpResponse } from '@angular/common/http';
import { environment } from '../../environments/environment';

/**
 * La dirección base de las peticiones.
 *
 * Sale del `environment` y no está escrita en cada servicio: cambiar a dónde
 * apunta la app es cambiar de archivo, no buscar y reemplazar en veinte
 * componentes.
 */
export const API = environment.api;

/**
 * Un error del sistema ya descrito.
 *
 * El sistema responde siempre con la misma forma:
 *
 *   { codigo: 'NO_ENCONTRADO', error: 'Recurso no encontrado', detalles?: [...] }
 *
 * `codigo` es estable y está en inglés; `error` es para personas y se
 * traduce. Por eso la app decide mirando el CÓDIGO y pinta el MENSAJE, y
 * nunca al revés: si el día de mañana el sistema reescribe un mensaje, la
 * app sigue funcionando y solo cambia lo que se lee.
 *
 * El original dice esto mismo en `core/errores.ts`, y el motivo es que los
 * textos se traducen y los códigos no.
 */
export class ErrorApi extends Error {
  constructor(
    readonly estado: number,
    readonly codigo: string,
    mensaje: string,
    readonly detalles: DetalleCampo[] = [],
    /** El `detalles` crudo del sistema, sin interpretar. Ver `ErrorLegible`. */
    readonly datos: unknown = null,
  ) {
    super(mensaje);
    this.name = 'ErrorApi';
  }

  /** El error es de validacion de campos y se puede pintar junto al campo. */
  get esValidacion(): boolean {
    return this.codigo === 'VALIDACION' && this.detalles.length > 0;
  }

  /** El mensaje de un campo concreto, para pegarlo debajo del input. */
  problemaDe(campo: string): string | null {
    return this.detalles.find((d) => d.campo === campo)?.problema ?? null;
  }
}

/** Una falla contra un campo especifico, tal como lo reporta el sistema. */
export interface DetalleCampo {
  campo: string;
  problema: string;
}

/** Lo que se le muestra a la persona, sea cual sea el error. */
export interface ErrorLegible {
  mensaje: string;
  /** Ya con el `codigo` resuelto a algo que la app sepa que hacer. */
  codigo: string;
  detalles: DetalleCampo[];
  /**
   * El `detalles` CRUDO del sistema, sin interpretar.
   *
   * Va aparte de `detalles` porque los dos niveles no significan lo mismo.
   * `detalles` es la lista de `{campo, problema}` de los 422 de
   * validacion, que es lo que se pinta junto a un input. En las reglas de
   * negocio el sistema manda un objeto con lo que el error sabe de verdad
   * (`STOCK_INSUFICIENTE` trae `existencia`, `solicitado` y `faltan`), y
   * tirarlo obliga a pintar "no hay producto suficiente" cuando se puede
   * decir "faltan 8 bultos".
   *
   * Va como `unknown` y no como una forma: cada codigo trae su propio
   * objeto y hacer una union de todos seria inventar una forma comun que
   * no existe. Quien lo use castea lo que su codigo le promise.
   */
  datos: unknown;
}

/**
 * Convierte cualquier fallo en un mensaje que se le pueda mostrar a la
 * persona que atiende el mostrador.
 *
 * Se resuelven los tres casos que pasan de verdad:
 *
 * 1. El sistema respondió con un error propio (4xx/5xx). Se usa su mensaje,
 *    que ya viene en español y escrito para quien lo lee.
 * 2. El sistema no respondió (status 0): se cayó, no hay internet, o el
 *    navegador está bloqueando la conexión porque `CORS_ORIGINS` no incluye
 *    este origen. Esto último solo le importa a quien desarrolla, no a quien
 *    usa el mostrador, por eso el mensaje que ve la persona es sencillo.
 * 3. Algo se rompió en la app antes de pedir nada.
 *
 * Se devuelve un objeto y no se lanza: cada pantalla decide qué mostrar. Un
 * `catch` que vuelve a lanzar deja el mismo error cruzando la app y cada
 * componente termina inventando su propia revisión.
 */
export function errorLegible(error: unknown): ErrorLegible {
  if (error instanceof HttpErrorResponse) {
    // No hubo respuesta de nadie.
    if (error.status === 0) {
      return {
        codigo: 'SIN_SERVIDOR',
        mensaje: 'No hay conexión. Revisa tu internet e inténtalo de nuevo.',
        detalles: [],
        datos: null,
      };
    }

    const cuerpo = error.error as { codigo?: string; error?: string; detalles?: unknown } | null;

    if (cuerpo && typeof cuerpo.codigo === 'string') {
      return {
        codigo: cuerpo.codigo,
        mensaje: cuerpo.error ?? 'La operación no se pudo completar',
        detalles: detallesDe(cuerpo.detalles),
        // Se pasa tal cual: el código ya lo eligió el sistema y cada uno
        // trae su propio objeto. Ver `datos` en `ErrorLegible`.
        datos: cuerpo.detalles ?? null,
      };
    }

    // Un 4xx/5xx que no viene del manejo normal de errores (una página de
    // error de nginx, un HTML de un proxy). Su texto no está en español.
    if (error.status >= 500) {
      return {
        codigo: 'ERROR_SERVIDOR',
        mensaje: 'No pudimos completar la operación. Inténtalo de nuevo en un momento.',
        detalles: [],
        datos: null,
      };
    }
  }

  return {
    codigo: 'ERROR_INESPERADO',
    mensaje: 'Algo salió mal. Inténtalo de nuevo.',
    detalles: [],
    datos: null,
  };
}

/**
 * El sistema manda `detalles` con forma distinta segun el error: una lista
 * de `{campo, problema}` en los de validacion, y objetos sueltos en las
 * reglas de negocio. Solo se interesa el primer caso; lo demas se ignora en
 * vez de inventar una forma comun que no existe.
 */
function detallesDe(detalles: unknown): DetalleCampo[] {
  if (!Array.isArray(detalles)) return [];
  return detalles.flatMap((d) => {
    const candidato = d as Partial<DetalleCampo> | null;
    if (
      candidato &&
      typeof candidato.campo === 'string' &&
      typeof candidato.problema === 'string'
    ) {
      return [{ campo: candidato.campo, problema: candidato.problema }];
    }
    return [];
  });
}

/**
 * Guarda en el equipo el Excel que devuelve el sistema.
 *
 * El archivo llega como un `Blob` y hay que convertirlo en una descarga: se
 * hace un `objectURL` temporal, se le pasa a un `<a>` con `download` y se
 * pulsa. El nombre sale del `Content-Disposition` del sistema, que es quien
 * sabe si va la fecha de hoy o el numero de la fila; el de aqui solo se usa si
 * esa cabecera no llega (un proxy que la quita, por ejemplo).
 *
 * El `revokeObjectURL` va con espera y no de inmediato: hay navegadores que
 * siguen leyendo del blob un instante despues del `click`, y si se libera
 * antes de tiempo la descarga llega vacia.
 */
export function descargarExcel(respuesta: HttpResponse<Blob>, nombrePorDefecto: string): void {
  const url = URL.createObjectURL(respuesta.body as Blob);
  const enlace = document.createElement('a');
  enlace.href = url;
  const disposition = respuesta.headers.get('content-disposition');
  enlace.download = /filename="([^"]+)"/.exec(disposition ?? '')?.[1] ?? nombrePorDefecto;
  enlace.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
