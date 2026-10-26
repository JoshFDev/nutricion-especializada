/**
 * Genera `configuracion.local.json` si todavía no existe.
 *
 * Ese archivo guarda dos cosas que no queremos dejar escritas en el código:
 *
 *   - La cuenta de administrador que se crea en el primer arranque.
 *   - Las credenciales SMTP para los correos de recuperación.
 *
 * Las credenciales SMTP se toman de `backend/.env` (que ya está ignorado por
 * git). El archivo generado también está ignorado y electron-builder lo copia
 * como `resources/configuracion.json` dentro de la aplicación.
 *
 * Si el archivo ya existe no se toca: puede que alguien lo haya ajustado a
 * mano para un cliente concreto.
 */
import { access, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const aqui = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(aqui, '..');
const raiz = resolve(desktop, '..');
const destino = join(desktop, 'configuracion.local.json');

const administrador = {
  nombre: 'Joshua',
  apellidoPaterno: 'Administrador',
  email: 'nutricionespecializada899@gmail.com',
  rfc: 'XAXX010101000',
  puesto: 'Administrador',
  contrasena: 'Nutricion2026!',
};

let smtp = {
  host: 'localhost',
  port: 25,
  secure: false,
  user: '',
  pass: '',
  from: 'Nutrición Especializada <no-reply@localhost>',
};

try {
  const env = dotenv.parse(await readFile(join(raiz, 'backend', '.env'), 'utf8'));
  smtp = {
    host: env.SMTP_HOST || smtp.host,
    port: Number(env.SMTP_PORT) || smtp.port,
    secure: env.SMTP_SECURE === 'true' || env.SMTP_SECURE === '1',
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
    from: env.SMTP_FROM || smtp.from,
  };
} catch {
  console.warn(
    '[config] No se encontró backend/.env. Se generará la configuración sin SMTP; ' +
      'la recuperación por correo no funcionará hasta configurarla.',
  );
}

try {
  await access(destino);
  console.log(`[config] Ya existe ${destino}; no se modifica.`);
} catch {
  await writeFile(destino, `${JSON.stringify({ admin: administrador, smtp }, null, 2)}\n`, 'utf8');
  console.log(`[config] Configuración creada en ${destino}`);
}
