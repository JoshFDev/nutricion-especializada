import { config as cargarDotenv } from 'dotenv';
import { z } from 'zod';

cargarDotenv();

const esquema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  PGHOST: z.string().min(1),
  PGPORT: z.coerce.number().int().positive().default(5432),
  PGDATABASE: z.string().min(1),
  PGUSER: z.string().min(1),
  PGPASSWORD: z.string().min(1),
  DB_SCHEMA: z.string().min(1).default('pos'),
  DB_MAX_CONEXIONES: z.coerce.number().int().min(2).max(100).default(10),

  CORS_ORIGINS: z.string().default('http://localhost:4200'),

  /**
   * Numero de proxy inversos delante de la app (nginx, Heroku, Railway...).
   * 0 = ninguno. Con 1 o mas se confia en X-Forwarded-For, que es lo que
   * hace que la IP en la auditoria sea la real y no la del proxy.
   * IMPORTANTE: no lo pongas en 1 si no hay proxy de verdad, porque
   * cualquiera podria mandar esa cabecera y falsear su IP.
   */
  TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(0),

  // Despite the old name, this is the session DURATION, not a JWT: the token
  // is opaque (random bytes) and what gets stored is its sha256.
  JWT_EXPIRES_IN: z.string().default('8h'),
});

const parseado = esquema.safeParse(process.env);

if (!parseado.success) {
  console.error('Falta configuración o es inválida:');
  for (const issue of parseado.error.issues) {
    console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
  }
  console.error('\nCopia .env.example a .env y llénalo.');
  process.exit(1);
}

export const env = parseado.data;

export const origenesCORS = env.CORS_ORIGINS.split(',')
  .map((o) => o.trim())
  .filter(Boolean);
