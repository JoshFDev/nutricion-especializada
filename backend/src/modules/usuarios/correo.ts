import { env } from '../../config/entorno.js';
import {
  adjuntoLogo,
  botonCorreo,
  cajaDatos,
  envolver,
  escaparHtml,
  parrafo,
} from '../../core/correo-marca.js';
import { enviarCorreo } from '../../core/correo.js';

export interface CuentaCreada {
  nombre: string;
  correo: string;
  /**
   * La clave de un solo uso, o `null` si la escribio el administrador.
   *
   * El `null` es un caso real, no un hueco: cuando la clave la eligio quien
   * dio de alta la cuenta, esa persona ya la conoce y se la va a entregar en
   * mano. Ponerla aqui seria mandar por correo una clave que nadie pidio que
   * viajara, y la pantalla de alta tampoco la muestra.
   */
  contrasenaTemporal: string | null;
}

const ENLACE = () => `${env.APP_URL}/login`;

/**
 * El cuerpo del correo de alta.
 *
 * Esta separado del envio a proposito: el HTML es lo unico que vale la pena
 * probar sin abrir un socket SMTP, y con la funcion aparte la prueba lee el
 * texto y no depende de que `enviarCorreo` exista.
 */
export function htmlCuentaCreada(datos: CuentaCreada): string {
  const empresa = escaparHtml(env.EMPRESA_NOMBRE);
  const credenciales = datos.contrasenaTemporal
    ? cajaDatos('Tus datos de acceso', [
        { etiqueta: 'Correo', valor: datos.correo },
        { etiqueta: 'Contraseña temporal', valor: datos.contrasenaTemporal },
      ])
    : parrafo(
        `Entra con tu correo <strong>${escaparHtml(datos.correo)}</strong> y la contraseña que te entregó quien creó la cuenta.`,
      );

  const aviso = datos.contrasenaTemporal
    ? parrafo(
        'Por seguridad, al iniciar sesión el sistema te pedirá cambiar esa contraseña temporal por una tuya.',
      )
    : '';

  const contenido = [
    parrafo(`Hola <strong>${escaparHtml(datos.nombre)}</strong>,`),
    parrafo(
      `Se creó tu cuenta en <strong>${empresa}</strong>. Ya puedes entrar al sistema con estos datos:`,
    ),
    credenciales,
    aviso,
    botonCorreo(ENLACE(), 'Iniciar sesión'),
    parrafo('Si no esperabas este correo, avisa al administrador.'),
  ].join('\n');

  return envolver({ titulo: `Tu cuenta en ${env.EMPRESA_NOMBRE}`, contenido });
}

/**
 * Avisa por correo que la cuenta quedo creada.
 *
 * El error sube: quien llama decide. En el alta de un usuario eso significa
 * registrar la falla y no tumbar la cuenta, que ya quedo guardada.
 */
export async function enviarCuentaCreada(datos: CuentaCreada): Promise<void> {
  const subject = `Tu cuenta en ${env.EMPRESA_NOMBRE}`;
  const text = [
    `Hola ${datos.nombre},`,
    '',
    `Se creó tu cuenta en ${env.EMPRESA_NOMBRE}.`,
    datos.contrasenaTemporal
      ? `\nCorreo: ${datos.correo}\nContraseña temporal: ${datos.contrasenaTemporal}\n\nPor seguridad, al iniciar sesión el sistema te pedirá cambiarla.`
      : `\nEntra con tu correo ${datos.correo} y la contraseña que te entregó quien creó la cuenta.`,
    '',
    `Inicia sesión en: ${ENLACE()}`,
    '',
    'Si no esperabas este correo, avisa al administrador.',
  ].join('\n');

  await enviarCorreo({
    to: datos.correo,
    subject,
    text,
    html: htmlCuentaCreada(datos),
    attachments: [await adjuntoLogo()],
  });
}
