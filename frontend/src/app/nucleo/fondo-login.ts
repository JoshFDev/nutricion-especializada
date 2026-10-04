/*
 * Que fondo del login recuerda el navegador.
 *
 * El fondo es la unica parte de la pantalla de login que es personalized, y
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
 * El login solo LEE de aqui. Quien escribe es la pantalla de perfil, con la
 * lista de fondos que da el backend, no este archivo.
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
export const FONDO_POR_DEFECTO = '/fondos/vacaLengua.jpg';

/**
 * Solo se acepta lo que parece una ruta nuestra o una URL completa.
 *
 * El valor viene de localStorage, o sea de este mismo navegador, asi que no es
 * un ataque: el usuario podria escribir a mano lo que quisiera en su propia
 * maquina. El filtro esta para que un valor corrupto (un `undefined` viejo,
 * una version anterior del formato) no termine puesto de fondo como
 * `background-image` y deje la pantalla en blanco.
 */
function esUsable(valor: string | null): valor is string {
  return typeof valor === 'string' && (valor.startsWith('/') || /^https?:\/\//.test(valor));
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

/** Guarda el fondo para la proxima vez. Lo llama la pantalla de perfil. */
export function guardarFondo(url: string): void {
  if (!esUsable(url)) return;
  try {
    localStorage.setItem(CLAVE, url);
  } catch {
    // Si no se puede guardar, el login sigue funcionando con lo que hubiera.
  }
}
