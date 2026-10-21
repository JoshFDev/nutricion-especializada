import { Router } from 'express';
import { env } from '../../config/entorno.js';
import { enTransaccion } from '../../db/transaccion.js';
import { NoEncontrado } from '../../core/errores.js';
import { entrarComo } from './servicio.js';

/**
 * Rutas que SOLO existen en desarrollo.
 *
 * La garantia de que esto no funciona en produccion es que `app.ts` monta
 * este router dentro de un `if (env.NODE_ENV === 'development')`. En
 * produccion no se monta el router, no hay ruta, y la peticion cae en el
 * 404 del final de `app.ts`. No es que la ruta mire el modo y se niegue.
 *
 * La segunda comprobacion de mas abajo responde 404 tambien. Son dos capas
 * a proposito: la de `app.ts` es la que protege, y la del manejador
 * protege de que alguien monte este router en otro archivo por error. Un
 * atajo que abre la administracion sin contrasena no puede depender de un
 * solo `if`.
 *
 * Para quitarlo del proyecto: borrar este archivo y el `if` de `app.ts`.
 * Son dos cosas. `entrarComo` en el servicio se puede dejar ahi, es codigo
 * muerto que el arbol de dependencias ya sacude.
 */
export const rutasAuthDev = Router();

/**
 * `POST /api/auth/dev/entrar-como`
 *
 * Body: `{ rol?: string }`, y sin rol, `Administrador`.
 *
 * El rol no se valida contra una lista de este archivo sino contra los
 * nombres de rol que hay en la base: un rol que no existe no encuentra a
 * nadie y sale un 404, y un rol que existe entra con el. Lo que no se puede
 * es obtener mas permisos de los que el rol ya tiene, porque los permisos
 * no se piden: se leen de la base como en cualquier login.
 */
rutasAuthDev.post('/entrar-como', async (req, res): Promise<void> => {
  /**
   * Esta comprobacion es una segunda barrera, no la primera.
   *
   * La primera es que `app.ts` NO MONTA este router salvo que NODE_ENV
   * valga exactamente 'development', asi que en produccion estas rutas
   * no existen y lo que llega cae en el 404 de `app.ts`.
   *
   * Esta de aqui esta para el caso de que alguien monte el router a
   * mano, o lo monte sin querer en otro sitio: si el entorno no es
   * desarrollo, la ruta se hace la muerta. Es lo contrario de lo que
   * hacia antes, que solo se cerraba en 'production' y dejaba vivo
   * cualquier otro valor.
   */
  if (env.NODE_ENV !== 'development') {
    // Mismo cuerpo que el 404 del final de `app.ts`, para que un barrido de
    // la API no distinga "no existe" de "existe pero no la puedes usar".
    throw new NoEncontrado();
  }

  const pedido = req.body as { rol?: unknown };
  const rol =
    typeof pedido?.rol === 'string' && pedido.rol.trim() ? pedido.rol.trim() : 'Administrador';

  const respuesta = await enTransaccion((c) =>
    entrarComo(c, rol, {
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    }),
  );

  res.json(respuesta);
});
