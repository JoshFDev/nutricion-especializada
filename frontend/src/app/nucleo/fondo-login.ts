/*
 * Que fondo del login recuerda el navegador.
 *
 * El fondo es la unica parte de la pantalla de login que es personalizado, y
 * aqui hay un problema de orden: la pantalla aparece ANTES de que el usuario
 * entre, asi que no hay sesion de la cual leer la preferencia. La copia que
 * vive en el servidor (`usuarios.fondo_login`) es la fuente de verdad, pero
 * solo se puede leer ya adentro.
 *
 * Por eso se guarda en los dos lados: el servidor manda la preferencia real
 * y este modulo guarda la ultima que se aplico, para que la siguiente vez que
 * se abra el login se pueda pintar ANTES de preguntar por la contrasena. Sin
 * esto se veria un destello con la imagen por defecto y luego un salto a la
 * personal, que es justo lo que se quiere evitar.
 *
 * Ademas de las del servidor, la misma clave puede guardar una IMAGEN PROPIA
 * del navegador (`guardarFondoPropio`): un data URL que el usuario eligio de
 * su equipo y que no existe en el proyecto ni en el servidor. El login no
 * distingue, para el es solo el fondo que este navegador recuerda.
 *
 * El login solo LEE de aqui. Quien escribe son las pantallas que muestran el
 * fondo: la de usuarios (con la lista que da el backend y con la imagen
 * propia), y en el futuro cualquier otra que lo quiera cambiar.
 */

/** La clave en localStorage. Versionada a proposito: si el formato cambia, la
 *  vieja queda huerfana y el navegador la borra por su cuenta, en vez de tener
 *  que migrarla a mano. */
const CLAVE = 'nutricion:fondo-login:v1';

/**
 * El fondo que se ve la primera vez, o si la guardada ya no existe.
 *
 * La misma ruta que declara `fondos-login.ts` en el backend. Si se cambia alla
 * hay que cambiar aqui: es el unico punto del frontend que conoce un nombre de
 * archivo, y es deliberado, para que el login tenga algo que pintar ANTES de
 * que exista sesion con la que preguntar al servidor.
 */
export const FONDO_POR_DEFECTO = '/fondos/establo.jpg';

/**
 * Solo se acepta lo que es una ruta nuestra, un data URL de imagen o una URL
 * completa.
 *
 * El valor viene de localStorage, o sea de este mismo navegador, asi que no es
 * un ataque: el usuario podria escribir a mano lo que quisiera en su propia
 * maquina. El filtro esta para que un valor corrupto (un `undefined` viejo,
 * una version anterior del formato) no termine puesto de fondo como
 * `background-image` y deje la pantalla en blanco.
 */
function esUsable(valor: string | null): valor is string {
  return (
    typeof valor === 'string' &&
    (valor.startsWith('/') || valor.startsWith('data:image/') || /^https?:\/\//.test(valor))
  );
}

/** El fondo guardado, o el de por defecto. Se llama en el constructor del login. */
export function leerFondo(): string {
  try {
    const guardado = localStorage.getItem(CLAVE);
    return esUsable(guardado) ? guardado : FONDO_POR_DEFECTO;
  } catch {
    // Con las cookies de terceros bloqueadas, o en modo privado de Safari,
    // `localStorage` lanza al leer. No es motivo para romper el login.
    return FONDO_POR_DEFECTO;
  }
}

/** Guarda el fondo para la proxima vez. Lo llama la pantalla de usuarios. */
export function guardarFondo(url: string): void {
  if (!esUsable(url)) return;
  try {
    localStorage.setItem(CLAVE, url);
  } catch {
    // Si no se puede guardar, el login sigue funcionando con lo que hubiera.
  }
}

/** La imagen propia del navegador, o `null` si no se ha guardado ninguna. */
export function leerFondoPropio(): string | null {
  try {
    const guardado = localStorage.getItem(CLAVE);
    return guardado !== null && guardado.startsWith('data:image/') ? guardado : null;
  } catch {
    return null;
  }
}

/** Quita la imagen propia del navegador. */
export function quitarFondoPropio(): void {
  try {
    localStorage.removeItem(CLAVE);
  } catch {
    // Igual que al guardar: sin almacenamiento la imagen no existe y no pasa nada.
  }
}

/** Lee un archivo del equipo como data URL. */
function aDatosUrl(archivo: Blob): Promise<string> {
  return new Promise((resolver, rechazar) => {
    const lector = new FileReader();
    lector.onerror = () => rechazar(new Error('No se pudo leer la imagen'));
    lector.onload = () => resolver(String(lector.result));
    lector.readAsDataURL(archivo);
  });
}

/**
 * Baja la imagen a un JPEG de ancho razonable.
 *
 * Una foto de celular pesa 3-6 MB y `localStorage` aguanta ~5 MB: guardarla
 * tal cual reventaria la clave y el fondo se perderia. Se redibuja en un
 * `canvas` (el navegador decodifica y re-comprime) y se guarda ese resultado,
 * que es lo unico que necesita un fondo de pantalla.
 */
export async function comprimirImagen(archivo: Blob, anchoMaximo = 1920): Promise<string> {
  const bruto = await aDatosUrl(archivo);

  const imagen = await new Promise<HTMLImageElement>((resolver, rechazar) => {
    const img = new Image();
    img.onload = () => resolver(img);
    img.onerror = () => rechazar(new Error('Ese archivo no es una imagen'));
    img.src = bruto;
  });

  const factor = Math.min(1, anchoMaximo / (imagen.naturalWidth || 1));
  const lienzo = document.createElement('canvas');
  lienzo.width = Math.max(1, Math.round(imagen.naturalWidth * factor));
  lienzo.height = Math.max(1, Math.round(imagen.naturalHeight * factor));

  const contexto = lienzo.getContext('2d');
  if (contexto === null) throw new Error('Este navegador no soporta pintar el fondo');
  contexto.drawImage(imagen, 0, 0, lienzo.width, lienzo.height);

  return lienzo.toDataURL('image/jpeg', 0.85);
}

/**
 * Guarda una imagen propia del equipo como fondo del login.
 *
 * Se comprime (ver `comprimirImagen`), se guarda en el navegador y se
 * devuelve el data URL para que la pantalla lo muestre. No viaja al servidor
 * ni se copia dentro del proyecto: vive solo en esta maquina.
 */
export async function guardarFondoPropio(archivo: Blob): Promise<string> {
  const imagen = await comprimirImagen(archivo);
  guardarFondo(imagen);
  return imagen;
}
