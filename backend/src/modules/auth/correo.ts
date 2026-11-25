import { env } from '../../config/entorno.js';
import {
  adjuntoLogo,
  cajaDatos,
  envolver,
  escaparHtml,
  parrafo,
} from '../../core/correo-marca.js';
import { enviarCorreo } from '../../core/correo.js';

/**
 * El cuerpo del correo de recuperacion.
 *
 * Separado del envio por la misma razon que el del alta: el HTML es lo unico
 * que vale la pena revisar sin abrir un socket SMTP.
 */
export function htmlRecuperacion(nombre: string, contrasenaTemporal: string): string {
  // No se pone botón de "Iniciar sesión": en la versión de escritorio no hay
  // una URL web a la que lleve, y confundía a quien recibía el correo.
  const contenido = [
    parrafo(`Hola <strong>${escaparHtml(nombre)}</strong>,`),
    parrafo('Has solicitado recuperar tu contraseña. Usa estos datos para iniciar sesión ahora:'),
    cajaDatos('Datos de acceso', [{ etiqueta: 'Contraseña temporal', valor: contrasenaTemporal }]),
    parrafo(
      'Por seguridad, al iniciar sesión el sistema te pedirá cambiar esa contraseña temporal por una tuya.',
    ),
    parrafo('Si no solicitaste este cambio, ignora este mensaje.'),
  ].join('\n');

  return envolver({ titulo: 'Recuperación de contraseña', contenido });
}

export async function enviarRecuperacionContrasena(
  correo: string,
  nombre: string,
  contrasenaTemporal: string,
): Promise<void> {
  const subject = `Recuperación de contraseña - ${env.EMPRESA_NOMBRE}`;
  const text = [
    `Hola ${nombre},`,
    '',
    'Has solicitado recuperar tu contraseña.',
    '',
    `Tu contraseña temporal es: ${contrasenaTemporal}`,
    '',
    'Por seguridad, al iniciar sesión el sistema te pedirá cambiar esa contraseña temporal por una tuya.',
    '',
    'Abre la aplicación de escritorio y entra con esa contraseña.',
    '',
    'Si no solicitaste este cambio, ignora este mensaje.',
  ].join('\n');

  await enviarCorreo({
    to: correo,
    subject,
    text,
    html: htmlRecuperacion(nombre, contrasenaTemporal),
    attachments: [await adjuntoLogo()],
  });
}
