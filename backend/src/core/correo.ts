import nodemailer, { type Attachment, type Transporter } from 'nodemailer';
import { env } from '../config/entorno.js';

/**
 * El transporte SMTP se arma una sola vez y se reutiliza.
 *
 * Gmail y la mayoria de los servidores dejan mejor pasar varios correos si
 * vienen de la misma conexion autenticada que si se abre y cierra una por
 * cada mensaje.
 */
let transporter: Transporter | null = null;

/**
 * Limites para no dejar una peticion colgada hablando con el SMTP.
 *
 * Nodemailer espera dos minutos para conectar y hasta diez para el socket.
 * Un ticket es un extra, no la venta: si Gmail no contesta, es mejor perder
 * el aviso que retener la peticion y una conexion del pool ese tiempo.
 */
const TIEMPO_CONEXION_MS = 10_000;
const TIEMPO_SALUDO_MS = 10_000;
const TIEMPO_SOCKET_MS = 30_000;

export function obtenerTransporter(): Transporter {
  if (transporter) return transporter;

  const auth =
    env.SMTP_USER || env.SMTP_PASS ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined;

  transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    connectionTimeout: TIEMPO_CONEXION_MS,
    greetingTimeout: TIEMPO_SALUDO_MS,
    socketTimeout: TIEMPO_SOCKET_MS,
    ...(auth ? { auth } : {}),
  });

  return transporter;
}

export interface EnviarCorreoParams {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /**
   * Adjuntos. Hoy solo se usa para incrustar el logo por `cid`: un correo
   * con `html` que apunta a una URL del frontend se veria roto justo cuando
   * el frontend no es publico, que es el caso normal en este sistema.
   */
  attachments?: Attachment[];
}

/**
 * Manda un correo.
 *
 * Deja que el error suba: quien llama decide si un correo que no salio debe
 * tumbar la operacion (una recuperacion de contrasena) o solo registrarse
 * (el ticket de una nota, que ya se guardo y no debe revertirse).
 */
export async function enviarCorreo(params: EnviarCorreoParams): Promise<void> {
  const t = obtenerTransporter();
  await t.sendMail({
    from: env.SMTP_FROM,
    to: params.to,
    subject: params.subject,
    text: params.text,
    html: params.html,
    attachments: params.attachments,
  });
}
