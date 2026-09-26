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

  CORS_ORIGINS: z.string().default('http://localhost:4200'),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET debe tener al menos 32 caracteres'),
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
