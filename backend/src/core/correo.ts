import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../config/entorno.js';

/**
 * El transporte SMTP se arma una sola vez y se reutiliza.
 *
 * Gmail y la mayoria de los servidores dejan mejor pasar varios correos si
 * vienen de la misma conexion autenticada que si se abre y cierra una por
 * cada mensaje.
 */
let transporter: Transporter | null = null;

export function obtenerTransporter(): Transporter {
  if (transporter) return transporter;

  const auth =
    env.SMTP_USER || env.SMTP_PASS
      ? { user: env.SMTP_USER, pass: env.SMTP_PASS }
      : undefined;

  transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    ...(auth ? { auth } : {}),
  });

  return transporter;
}

export interface EnviarCorreoParams {
  to: string;
  subject: string;
  text: string;
  html?: string;
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
  });
}
