import { Router } from 'express';
import { baseViva } from '../../db/pool.js';

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
    baseDatos: viva ? 'conectada' : 'sin respuesta',
    version: process.env.npm_package_version ?? '1.0.0',
  });
});
