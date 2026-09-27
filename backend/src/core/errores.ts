/**
 * Jerarquia de errores de la aplicacion.
 *
 * Cada error lleva un `codigo` estable y legible por maquina
 * ('CLIENTE_DUPLICADO'). El frontend decide que hacer mirando ese codigo,
 * nunca el texto del mensaje: los mensajes se traducen, los codigos no.
 */

export class AppError extends Error {
  constructor(
    readonly estado: number,
    readonly codigo: string,
    mensaje: string,
    readonly detalles?: unknown,
    options?: { cause?: unknown },
  ) {
    super(mensaje, options);
    this.name = new.target.name;
    Error.captureStackTrace?.(this, new.target);
  }
}

/** 400: el cliente mando algo que no cumple el contrato. */
export class ErrorValidacion extends AppError {
  constructor(mensaje = 'Los datos enviados no son validos', detalles?: unknown) {
    super(400, 'VALIDACION', mensaje, detalles);
  }
}

/** 401: no hay sesion, o la que hay ya no sirve. */
export class NoAutenticado extends AppError {
  constructor(mensaje = 'Necesitas iniciar sesion') {
    super(401, 'NO_AUTENTICADO', mensaje);
  }
}

/** 403: hay sesion, pero el rol no alcanza. */
export class Prohibido extends AppError {
  constructor(mensaje = 'Tu rol no tiene permiso para esta operacion') {
    super(403, 'PROHIBIDO', mensaje);
  }
}

/** 404: el recurso no existe o no es visible para quien pregunta. */
export class NoEncontrado extends AppError {
  constructor(mensaje = 'Recurso no encontrado') {
    super(404, 'NO_ENCONTRADO', mensaje);
  }
}

/** 409: choca con el estado actual (duplicado, referencia en uso). */
export class Conflicto extends AppError {
  constructor(codigo: string, mensaje: string, detalles?: unknown) {
    super(409, codigo, mensaje, detalles);
  }
}

/** 422: se entiende el peticion, pero no tiene sentido aplicarla. */
export class ReglaNegocio extends AppError {
  constructor(codigo: string, mensaje: string, detalles?: unknown) {
    super(422, codigo, mensaje, detalles);
  }
}

export const esAppError = (error: unknown): error is AppError => error instanceof AppError;
