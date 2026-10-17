import { enviarCorreo } from '../../core/correo.js';
import { env } from '../../config/entorno.js';

export async function enviarRecuperacionContrasena(
  correo: string,
  nombre: string,
  contrasenaTemporal: string,
): Promise<void> {
  const subject = 'Recuperación de contraseña - Nutrición Especializada';
  const resetLink = `${env.APP_URL}/login`;
  const text = `Hola ${nombre},

Has solicitado recuperar tu contraseña.

Tu contraseña temporal es: ${contrasenaTemporal}

Por seguridad, al iniciar sesión deberás cambiarla.

Enlace para iniciar sesión: ${resetLink}

Si no solicitaste este cambio, ignora este mensaje.`;
  const html = `<p>Hola <strong>${nombre}</strong>,</p>
<p>Has solicitado recuperar tu contraseña.</p>
<p><strong>Contraseña temporal:</strong> <code>${contrasenaTemporal}</code></p>
<p>Por seguridad, al iniciar sesión deberás cambiarla.</p>
<p><a href="${resetLink}">Iniciar sesión</a></p>
<p>Si no solicitaste este cambio, ignora este mensaje.</p>`;
  await enviarCorreo({ to: correo, subject, text, html });
}
