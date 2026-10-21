import { config as cargarDotenv } from 'dotenv';
import { z } from 'zod';

cargarDotenv();

const esquema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),

  /**
   * El modo en el que corre la app. OBLIGATORIO, sin valor por omision.
   *
   * Antes el valor por omision era 'development', y eso era un agujero:
   * `app.ts` monta las rutas de desarrollo (`POST /api/auth/dev/entrar-como`,
   * que da un token de administrador sin contrasena) cuando NODE_ENV vale
   * exactamente 'development'. Un despliegue que copiase el .env de
   * ejemplo sin revisar esa linea se quedaria con esas rutas vivas.
   *
   * Ahora, si falta, la app NO ARRANCA y lo dice. Es un fallo ruidoso en
   * el arranque, mejor que un fallo silencioso en produccion.
   */
  NODE_ENV: z.enum(['development', 'test', 'production']),

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

  /**
   * Datos del emisor, que salen impresos en el PDF de la nota de remision.
   *
   * Van en el entorno y no en una tabla porque no son datos del negocio:
   * son el membrete, que cambia cuando cambias de domicilio o de regimen
   * fiscal, y no cuando llega una venta. Meterlos en el codigo obligaria a
   * tocar y redesplegar la app para corregir un telefono mal escrito, y a
   * meterlos en la base obligaria a migrar datos que no cambian.
   *
   * Solo el nombre es obligatorio: es el titulo del documento. Los demas se
   * omiten y el PDF no imprime la linea, en vez de imprimir un "-".
   */
  EMPRESA_NOMBRE: z.string().default('Nutricion Especializada'),
  EMPRESA_RFC: z.string().default(''),
  EMPRESA_DIRECCION: z.string().default(''),
  EMPRESA_TELEFONO: z.string().default(''),

  /**
   * Correo saliente (SMTP). Con Gmail basta una contrasena de aplicacion:
   * la cuenta normal no deja autenticar SMTP aunque la clave sea correcta.
   *
   * SMTP_SECURE NO puede ser `z.coerce.boolean()`: convertido desde texto,
   * CUALQUIER cadena no vacia da true, "false" incluido, y con el puerto 587
   * eso intenta TLS desde el saludo y la conexion falla. Solo "true" o "1"
   * encienden el modo seguro.
   */
  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: z
    .union([z.boolean(), z.string()])
    .default(false)
    .transform((v) => (typeof v === 'boolean' ? v : v === 'true' || v === '1')),
  SMTP_USER: z.string().default(''),
  SMTP_PASS: z.string().default(''),
  SMTP_FROM: z.string().default('Nutrición Especializada <no-reply@localhost>'),

  /** URL del frontend, para armar los enlaces que van dentro del correo. */
  APP_URL: z.string().default('http://localhost:4200'),
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
