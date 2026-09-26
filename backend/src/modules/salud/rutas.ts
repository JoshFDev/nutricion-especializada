import { Router } from 'express';
import { baseViva } from '../../db/pool.js';
import { env } from '../../config/entorno.js';

export const rutasSalud = Router();

/**
 * Sondas para el despliegue.
 *
 * /api/salud responde 200 si la base contesta y 503 si no. Esa diferencia
 * importa: un 503 dice "reinicia el pod", un 200 con la base caida dice
 * "el problema es la base", y sonrmsejistras muy distintas.
 */
rutasSalud.get('/salud', async (_req, res) => {
  const viva = await baseViva();
  res.status(viva ? 200 : 503).json({
    estado: viva ? 'ok' : 'degradado',
    // El nombre de la base va exposed a proposito. Las pruebas de
    // integracion lo leen para negarse a correr contra la base real: sin
    // esto, un `pnpm dev` olvidado apuntando a la base verdadera hace que
    // la suite cree y borre registros de verdad, y deje contrasenas
    // cambiadas. En una app de escritorio no hay nada que filtrar aqui;
    // en un servicio publico esto no se expondría.
    base: env.PGDATABASE,
    conexion: viva ? 'ok' : 'sin respuesta',
    version: process.env.npm_package_version ?? '1.0.0',
  });
});
