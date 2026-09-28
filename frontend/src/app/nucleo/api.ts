import { HttpErrorResponse } from '@angular/common/http';
import { environment } from '../../environments/environment';

/**
 * Base de la API.
 *
 * Sale del `environment` y no esta escrita en los servicios: cambiar de
 * servidor es cambiar de archivo, no buscar y reemplazar en veinte
 * componentes.
 */
export const API = environment.api;

/**
 * Un error de la API ya descrito.
 *
 * El backend responde siempre con la misma forma:
 *
 *   { codigo: 'NO_ENCONTRADO', error: 'Recurso no encontrado', detalles?: [...] }
 *
 * `codigo` es estable y esta en ingles; `error` es para personas y se
 * traduce. Por eso la app decide mirando el CODIGO y pinta el MENSAJE, y
 * nunca al reves: si el dia de manana el backend reescribe un mensaje, la
 * app sigue funcionando y solo cambia lo que se lee.
 *
 * El original dice esto mismo en `core/errores.ts`, y el motivo es que los
 * textos se traducen y los codigos no.
 */
export class ErrorApi extends Error {
  constructor(
    readonly estado: number,
    readonly codigo: string,
    mensaje: string,
    readonly detalles: DetalleCampo[] = [],
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

/** Una falla contra un campo especifico, tal como lo reporta el backend. */
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
}

/**
 * Convierte cualquier fallo en algo que se pueda pintar.
 *
 * Se come los tres casos que se dan de verdad:
 *
 * 1. La API respondio con un error de la app (4xx/5xx). Se usa su mensaje,
 *    que ya esta en espanol y esta escrito para el que lo lee.
 * 2. La API no respondio (status 0): el backend esta caido, no hay red, o
 *    el navegador esta bloqueando el puerto 3000 porque `CORS_ORIGINS` no
 *    incluye el origen. Es el caso que mas confunde cuando se desarrolla, y
 *    por eso el mensaje dice las dos cosas.
 * 3. Algo se rompio en la app antes de pedir nada.
 *
 * Se devuelve un objeto y no se lanza: la pantalla decide que hacer. Un
 * `catch` que re-lanza deja el mismo error cruzando la app y cada
 * componente termina inventando su propio `if (e.status === 401)`.
 */
export function errorLegible(error: unknown): ErrorLegible {
  if (error instanceof HttpErrorResponse) {
    // Sin respuesta del servidor.
    if (error.status === 0) {
      return {
        codigo: 'SIN_SERVIDOR',
        mensaje:
          'No se pudo contactar al servidor. Revisa que este encendido el backend ' +
          'y que este permitido este origen.',
        detalles: [],
      };
    }

    const cuerpo = error.error as { codigo?: string; error?: string; detalles?: unknown } | null;

    if (cuerpo && typeof cuerpo.codigo === 'string') {
      return {
        codigo: cuerpo.codigo,
        mensaje: cuerpo.error ?? 'La operacion no se pudo completar',
        detalles: detallesDe(cuerpo.detalles),
      };
    }

    // Un 4xx/5xx que no viene del manejador de errores (un 404 de nginx, un
    // HTML de un proxy). El texto del backend no esta en espanol.
    if (error.status >= 500) {
      return {
        codigo: 'ERROR_SERVIDOR',
        mensaje: 'El servidor fallo. Intenta de nuevo en un momento.',
        detalles: [],
      };
    }
  }

  return {
    codigo: 'ERROR_INESPERADO',
    mensaje: 'Ocurrio un error inesperado.',
    detalles: [],
  };
}

/**
 * El backend manda `detalles` con forma distinta segun el error: una lista
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
