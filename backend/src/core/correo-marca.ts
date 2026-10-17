import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Attachment } from 'nodemailer';
import { env } from '../config/entorno.js';

/**
 * La marca de los correos que salen del sistema.
 *
 * Un correo de la empresa no puede ser un `<p>` pelon: el cliente lo abre en
 * el movil y lo primero que ve es si parece de la empresa o de un desconocido.
 * Por eso el logo y el color viven aqui y no repartidos por cada modulo.
 *
 * El logo NO se enlaza por URL. El frontend corre en la maquina del negocio
 * (`localhost`), asi que un `<img src="http://localhost:4200/...">` saldria
 * roto en cuanto el correo salga a internet. Se incrusta: el PNG va adjunto y
 * el HTML lo pide por `cid:`, que es lo unico que el cliente de correo va a
 * poder resolver.
 *
 * Las tablas y los estilos en linea no son nostalgia: Outlook y Gmail
 * ignoran hojas de estilo y `flex`, y una maquetacion con `div` se desarma.
 * `role="presentation"` es para que el lector de pantalla no anuncie una
 * tabla que solo esta puesta para poner el logo a la izquierda.
 */

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUTA_LOGO = join(RAIZ, 'plantillas', 'logo-nutricion.png');

/** El nombre con el que el HTML pide el logo adjunto. */
export const LOGO_CID = 'logo-nutricion';

const ACENTO = '#1e40af';
const ACENTO_ARRIBA = '#2f56d4';
const ACENTO_SUAVE = '#e3ebfb';
const ACENTO_BORDE = '#c7d6f7';
const TEXTO = '#1b1f24';
const TEXTO_SUAVE = '#5a6169';
const TEXTO_TENUE = '#6e757d';
const BORDE = '#d7dae0';
const FONDO = '#f4f5f7';

const FUENTE = "'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

/**
 * El logo leido una sola vez.
 *
 * No es una micro-optimizacion: cada alta leeria 75 KB del disco para nada,
 * y el archivo no cambia mientras el proceso vive. Se guarda el `Buffer` y
 * se reusa, igual que el transporte SMTP.
 */
let logoEnMemoria: Buffer | null = null;

async function leerLogo(): Promise<Buffer> {
  logoEnMemoria ??= await readFile(RUTA_LOGO);
  return logoEnMemoria;
}

/** El logo como adjunto incrustado, listo para `attachments`. */
export async function adjuntoLogo(): Promise<Attachment> {
  return {
    filename: 'logo-nutricion.png',
    content: await leerLogo(),
    cid: LOGO_CID,
    contentDisposition: 'inline',
  };
}

/**
 * Escapa el texto que se mete dentro del HTML.
 *
 * Los nombres los escribe una persona y el `&` de una razon social o un
 * apellido con acentos no deberian romper la maquetacion ni colarse como
 * etiqueta. El `cid` y los `href` de configuracion NO pasan por aqui: ya son
 * valores controlados y escaparles el `&` solo los ensuciaria.
 */
export function escaparHtml(texto: string): string {
  return texto
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface EnvolturaParams {
  /** El titulo del encabezado. Suele ser el asunto, para reencontrarlo. */
  titulo: string;
  /** El cuerpo ya en HTML: parrafos, cajas y botones. */
  contenido: string;
}

/**
 * El marco del correo: logo arriba, banda azul con el nombre y el cuerpo.
 *
 * Cada modulo arma su `contenido` con las piezas de abajo (`botonCorreo`,
 * `cajaDatos`) y lo mete aqui. Asi la marca es la misma en el alta de un
 * usuario y en la recuperacion de contrasena sin copiar el HTML en los dos.
 */
export function envolver({ titulo, contenido }: EnvolturaParams): string {
  const empresa = escaparHtml(env.EMPRESA_NOMBRE);
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${escaparHtml(titulo)}</title>
</head>
<body style="margin:0;padding:0;background:${FONDO};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${FONDO};">
  <tr>
    <td align="center" style="padding:32px 12px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;background:#ffffff;border:1px solid ${BORDE};border-radius:14px;overflow:hidden;font-family:${FUENTE};">
        <tr>
          <td align="center" style="padding:28px 24px 16px;">
            <img src="cid:${LOGO_CID}" alt="${empresa}" width="104" height="104" style="display:block;border:0;outline:none;height:auto;max-width:104px;">
          </td>
        </tr>
        <tr>
          <td align="center" style="background:${ACENTO};background-image:linear-gradient(180deg, ${ACENTO_ARRIBA} 0%, ${ACENTO} 60%);padding:16px 24px;">
            <span style="color:#ffffff;font-size:13px;font-weight:600;letter-spacing:1.4px;text-transform:uppercase;">${empresa}</span>
          </td>
        </tr>
        <tr>
          <td style="padding:32px 32px 8px;color:${TEXTO};font-size:15px;line-height:1.65;">
            ${contenido}
          </td>
        </tr>
        <tr>
          <td style="padding:24px 32px 32px;color:${TEXTO_TENUE};font-size:13px;line-height:1.6;">
            <div style="border-top:1px solid #eef0f3;padding-top:16px;">Este mensaje se generó automáticamente; por favor no respondas a este correo.</div>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

/** Un parrafo del cuerpo, con el estilo de la casa. */
export function parrafo(html: string): string {
  return `<p style="margin:0 0 16px;">${html}</p>`;
}

/** El boton azul de "entrar". Se envuelve en tabla por Outlook. */
export function botonCorreo(href: string, texto: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 8px;">
  <tr>
    <td style="border-radius:8px;background:${ACENTO};">
      <a href="${href}" target="_blank" style="display:inline-block;padding:12px 28px;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;border-radius:8px;">${escaparHtml(texto)}</a>
    </td>
  </tr>
</table>`;
}

export interface FilaDato {
  etiqueta: string;
  valor: string;
}

/**
 * La caja azul clara donde van los datos que hay que copiar.
 *
 * La contrasena va aqui y no en un parrafo suelto porque es lo unico que la
 * persona va a leer dos veces: una para verla y otra para teclearla.
 */
export function cajaDatos(titulo: string, filas: FilaDato[]): string {
  const renglones = filas
    .map(
      (fila, i) => `<tr>
        <td style="padding:${i === 0 ? '0' : '10px'} 0 0;color:${TEXTO_SUAVE};font-size:13px;">${escaparHtml(fila.etiqueta)}</td>
      </tr>
      <tr>
        <td style="color:${TEXTO};font-size:15px;font-weight:600;word-break:break-word;">${escaparHtml(fila.valor)}</td>
      </tr>`,
    )
    .join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:4px 0 20px;background:${ACENTO_SUAVE};border:1px solid ${ACENTO_BORDE};border-radius:10px;">
  <tr>
    <td style="padding:16px 18px;">
      <div style="color:${ACENTO};font-size:12px;font-weight:700;letter-spacing:0.8px;text-transform:uppercase;margin-bottom:12px;">${escaparHtml(titulo)}</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${renglones}</table>
    </td>
  </tr>
</table>`;
}
