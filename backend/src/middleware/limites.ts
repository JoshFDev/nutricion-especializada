import { rateLimit, type Options } from 'express-rate-limit';
import { env } from '../config/entorno.js';

const comun = {
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // Solo se confía en X-Forwarded-For si hay un proxy delante. Si no lo hay
  // y se confiara, cualquiera podria mandar esa cabecera y saltarse el
  // limiteponiendo la IP que quisiera.
  validate: {
    trustProxy: env.TRUST_PROXY > 0,
    xForwardedForHeader: env.TRUST_PROXY > 0,
  },
} satisfies Partial<Options>;

/**
 * Techo general: evita que un bucle de scripting se coma la API.
 *
 * Mismo criterio que limiteLogin y por el mismo motivo: el valor sale de
 * API_MAX_PETICIONES y NO se relaja solo por estar en desarrollo. Si
 * alguien despliega arrastrando el .env de desarrollo, este limite queda
 * inservible sin que nadie se entere. Para correr la suite de integracion
 * se sube explicitamente en el .env local.
 */
export const limiteGeneral = rateLimit({
  ...comun,
  windowMs: 15 * 60 * 1000,
  limit: env.API_MAX_PETICIONES,
  message: { codigo: 'DEMASIADAS_PETICIONES', error: 'Demasiadas peticiones' },
});

/**
 * Login: es la unica puerta que se ataca por fuerza bruta, asi que lleva
 * su propio limite, bastante mas estricto que el general.
 *
 * El valor sale de LOGIN_MAX_INTENTOS y NO se relaja automaticamente por
 * estar en desarrollo: si alguien despliega sin poner
 * NODE_ENV=production y el limite quedara en 100, tendria 100 intentos
 * por cuarto de hora sin enterarse. Para correr las pruebas se sube
 * explicitamente en el .env local.
 */
export const limiteLogin = rateLimit({
  ...comun,
  windowMs: 15 * 60 * 1000,
  limit: env.LOGIN_MAX_INTENTOS,
  message: {
    codigo: 'DEMASIADOS_INTENTOS',
    error: 'Demasiados intentos. Espera unos minutos.',
  },
});
