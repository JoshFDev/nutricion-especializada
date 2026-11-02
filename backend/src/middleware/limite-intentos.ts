import type { NextFunction, Request, Response } from 'express';
import { DemasiadasPeticiones } from '../core/errores.js';

/**
 * Limite de peticiones por IP, en memoria.
 *
 * Para que sirve. El login ya bloquea la CUENTA despues de cinco intentos
 * fallidos (`servicio.ts`). Eso no detiene a quien prueba el mismo correo
 * desde otra cuenta, ni a quien prueba muchos correos distintos, ni a quien
 * llena la bandeja de recuperacion de contrasenas. Este limite es por
 * direccion y corta ese ruido antes de llegar a la base.
 *
 * Por que en memoria y no en la base. La aplicacion es de UNA computadora y
 * la API corre en el mismo proceso que la usa: no hay varias instancias que
 * compartir, y reiniciar el backend borra el conteo, que es justo lo que se
 * quiere (un reinicio no es un ataque). Guardarlo en una tabla seria abrir
 * una transaccion por cada intento de login, que es el peor lugar para
 * agregar trabajo.
 *
 * La ventana es fija y empieza con la primera peticion de esa IP. No es el
 * algoritmo mas fino, pero es el que se puede explicar: "veinte intentos
 * cada diez minutos". Con ventana deslizante el mismo usuario veria que a
 * veces lo deja y a veces no, sin poder decir por que.
 */
export interface OpcionesLimite {
  /** Cuantas peticiones se aceptan dentro de la ventana. */
  maximo: number;
  /** Cuanto dura la ventana, en milisegundos. */
  ventanaMs: number;
  /** El texto que ve la persona cuando se pasa. */
  mensaje?: string;
}

interface Registro {
  /** Cuando empezo la ventana de esta IP. */
  inicio: number;
  /** Cuantas peticiones lleva dentro de la ventana. */
  conteo: number;
}

/** Cada cuanto se tiran los registros viejos. */
const LIMPIEZA_MS = 60_000;

export function crearLimiteIntentos(opciones: OpcionesLimite) {
  const { maximo, ventanaMs, mensaje } = opciones;
  const registros = new Map<string, Registro>();

  /**
   * La limpieza no es opcional: sin ella el mapa crece con cada IP que
   * alguna vez entro, y en una aplicacion que se queda abierta meses eso es
   * una fuga lenta. `unref` hace que este temporizador no impida que el
   * proceso termine, que en las pruebas y al apagar importa.
   */
  const temporizador = setInterval(() => {
    const ahora = Date.now();
    for (const [ip, registro] of registros) {
      if (ahora - registro.inicio >= ventanaMs) registros.delete(ip);
    }
  }, LIMPIEZA_MS);
  temporizador.unref?.();

  return function limite(req: Request, res: Response, next: NextFunction): void {
    const ahora = Date.now();
    const ip = req.ip ?? req.socket.remoteAddress ?? 'desconocida';
    const registro = registros.get(ip);

    if (!registro || ahora - registro.inicio >= ventanaMs) {
      registros.set(ip, { inicio: ahora, conteo: 1 });
      next();
      return;
    }

    if (registro.conteo >= maximo) {
      const esperaSegundos = Math.max(1, Math.ceil((registro.inicio + ventanaMs - ahora) / 1000));
      res.setHeader('Retry-After', String(esperaSegundos));
      next(
        new DemasiadasPeticiones(mensaje, {
          reintentarEnSegundos: esperaSegundos,
        }),
      );
      return;
    }

    registro.conteo += 1;
    next();
  };
}
