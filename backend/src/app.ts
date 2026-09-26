import express, { type Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { env, origenesCORS } from './config/entorno.js';
import { prepararSesion } from './middleware/sesion.js';
import { manejadorErrores } from './middleware/errores.js';
import { limiteGeneral, limiteLogin } from './middleware/limites.js';
import { NoEncontrado } from './core/errores.js';
import { rutasSalud } from './modules/salud/rutas.js';
import { rutasAuth } from './modules/auth/rutas.js';
import { rutasClientes } from './modules/clientes/rutas.js';
import { rutasUsuarios } from './modules/usuarios/rutas.js';

/**
 * Composicion de la aplicacion: aqui se decide el ORDEN en que corre el
 * middleware. Ese orden es la parte sutil de Express, por eso esta
 * separado de index.ts (que solo arranca el servidor) y de los modulos.
 *
 * El orden importa y va de fuera hacia dentro:
 *   1. confianza en el proxy
 *   2. cabeceras de seguridad
 *   3. CORS
 *   4. cuerpo JSON
 *   5. logs
 *   6. limites de peticiones
 *   7. sesion (abre la conexion a la base)
 *   8. rutas
 *   9. 404
 *  10. manejador de errores (siempre al final)
 */
export function crearApp(): Express {
  const app = express();

  // 1. Confiar en X-Forwarded-For SOLO si hay un proxy delante. Con 0, cada
  //    peticion registra la IP real y nadie puede falsearla mandando la
  //    cabecera a mano.
  app.set('trust proxy', env.TRUST_PROXY);

  // 2. Cabeceras de seguridad (CSP, X-Content-Type-Options, HSTS...)
  app.use(helmet());

  // 3. CORS con lista blanca, no comodin: el origen se compara exacto.
  app.use(cors({ origin: origenesCORS, credentials: true }));

  // 4. Solo JSON. El limite de 1mb evita que alguien mande un cuerpo
  //    gigante para tumbar el proceso.
  app.use(express.json({ limit: '1mb' }));

  // 5. Logs de acceso
  app.use(morgan(env.NODE_ENV === 'production' ? 'combined' : 'dev'));

  // 6. Limites de peticiones
  app.use(limiteGeneral);
  app.use('/api/auth/login', limiteLogin);

  // 7. Sesion: abre la conexion dedicada del request y la devuelve al pool
  //    al terminar. Se monta en /api para que las rutas de salud no
  //    dependan de la base.
  app.use('/api', prepararSesion);

  // 8. Rutas
  app.use('/api', rutasSalud);
  app.use('/api/auth', rutasAuth);
  app.use('/api/clientes', rutasClientes);
  app.use('/api/usuarios', rutasUsuarios);

  // 9. Cualquier otra ruta de /api no existe
  app.use('/api', (_req, _res, next) => {
    next(new NoEncontrado('Ese endpoint no existe'));
  });

  // 10. Manejador de errores. Siempre el ultimo: Express lo reconoce
  //     por tener 4 argumentos, y todo lo que se registre despues ya
  //     nunca se ejecutaria.
  app.use(manejadorErrores);

  return app;
}
