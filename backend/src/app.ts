import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { env, origenesCORS } from './config/entorno.js';
import { prepararSesion } from './middleware/sesion.js';
import { manejadorErrores, noEncontrado } from './middleware/errores.js';import { baseViva } from './db/pool.js';
import { rutasAuth } from './modules/auth/rutas.js';
import { rutasClientes } from './modules/clientes/rutas.js';

export function crearApp() {
  const app = express();

  // Detras de un proxy (nginx, Heroku) req.ip da la IP del proxy.
  // Sin esto, todos los registros de auditoria quedan con la misma IP.
  app.set('trust proxy', 1);

  app.use(helmet());
  app.use(
    cors({
      origin: origenesCORS,
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(morgan(env.NODE_ENV === 'production' ? 'combined' : 'dev'));

  // Limite global, y uno mas estricto para el login: es la puerta que
  // se ataca con fuerza bruta.
  app.use(
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 300,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
    }),
  );
  app.use(
    '/api/auth/login',
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 10,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { error: 'Demasiados intentos. Espera unos minutos.' },
    }),
  );

  // Cada request recibe su propia conexion y su identidad.
  app.use('/api', prepararSesion);

  app.get('/api/salud', async (_req, res) => {
    const viva = await baseViva();
    res.status(viva ? 200 : 503).json({
      estado: viva ? 'ok' : 'degradado',
      baseDatos: viva ? 'conectada' : 'sin respuesta',
      version: process.env.npm_package_version ?? '1.0.0',
    });
  });

  app.use('/api/auth', rutasAuth);
  app.use('/api/clientes', rutasClientes);

  // Cualquier ruta /api que no exista cae aqui.
  app.use('/api', (_req, _res, next) => {
    next(noEncontrado('Ese endpoint no existe'));
  });
  app.use(manejadorErrores);

  return app;
}
