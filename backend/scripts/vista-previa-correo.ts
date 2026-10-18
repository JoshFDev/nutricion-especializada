/**
 * Genera una vista previa en el navegador de los correos, con el logo
 * incrustado como data URI (en el navegador el `cid:` no resuelve).
 *
 * Es un script temporal para revisar el diseno a ojo. No forma parte de la app.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { htmlRecuperacion } from '../src/modules/auth/correo.js';
import { htmlCuentaCreada } from '../src/modules/usuarios/correo.js';

const aquí = dirname(fileURLToPath(import.meta.url));
const logo = await readFile(join(aquí, '..', 'plantillas', 'logo-nutricion.png'));
const dataUri = `data:image/png;base64,${logo.toString('base64')}`;

const conClave = htmlCuentaCreada({
  nombre: 'María López Hernández',
  correo: 'maria@example.com',
  contrasenaTemporal: 'Kf7#mQ2pRt9Wz',
});
const sinClave = htmlCuentaCreada({
  nombre: 'María López Hernández',
  correo: 'maria@example.com',
  contrasenaTemporal: null,
});

const recuperacion = htmlRecuperacion('María López Hernández', 'Kf7#mQ2pRt9Wz');

const envolver = (titulo: string, html: string) =>
  `<section style="padding:8px 0 4px"><h2 style="font:600 16px system-ui">${titulo}</h2>${html.replace(
    /cid:logo-nutricion/g,
    dataUri,
  )}</section>`;

const pagina = `<!doctype html><meta charset="utf-8"><title>Vista previa de correos</title>
<body style="margin:0;background:#e9ebee">${envolver('Alta con contraseña temporal', conClave)}${envolver(
  'Alta con contraseña elegida por el administrador',
  sinClave,
)}${envolver('Olvidé mi contraseña', recuperacion)}</body>`;

const destino = join(aquí, '..', '..', 'vista-previa-correo.html');
await writeFile(destino, pagina, 'utf8');
console.log('Escrito:', destino);
