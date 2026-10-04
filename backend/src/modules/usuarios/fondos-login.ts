/**
 * Los fondos disponibles para la pantalla de login.
 *
 * Esta constante es la fuente de verdad de cuales son: la migracion 0013 la
 * repite en un CHECK, el endpoint la expone y el perfil la muestra. Agregar
 * una imagen son tres pasos y en este orden, porque el CHECK va primero:
 *
 *   1. Dejar el archivo en `frontend/public/fondos/`.
 *   2. Ampliar el CHECK de `usuarios_fondo_login_check` en una migracion NUEVA
 *      (0013 ya aplicada no se edita).
 *   3. Agregar la entrada aqui.
 *
 * Por que una clave y no una ruta: el valor elegido por el usuario se guarda en
 * `usuarios.fondo_login` y desde ahi sale derecho a un `background-image` del
 * frontend. Si fuera una ruta libre, escribir "/../../etc/passwd" en la propia
 * cuenta seria una forma de pedirle un archivo al servidor. Con la clave, lo
 * que no este en esta lista no llega a existir.
 *
 * Los archivos se sirven desde `public/`, o sea que pasan por el build de
 * Angular: no hay lectura de disco en el backend ni ruta dinamica.
 */
export const FONDOS_LOGIN = [
  {
    clave: 'vacaLengua',
    etiqueta: 'Vaca con lengua',
    url: '/fondos/vacaLengua.jpg',
  },
  {
    clave: 'vacaFondo',
    etiqueta: 'Fondo vertical',
    url: '/fondos/vacaFondo.jpg',
  },
] as const;

export type ClaveFondo = (typeof FONDOS_LOGIN)[number]['clave'];

/** Un fondo, tal como lo consume el frontend. */
export type FondoLogin = (typeof FONDOS_LOGIN)[number];

/** El fondo de quien no eligió nada. */
export const FONDO_LOGIN_DEFECTO = 'vacaLengua';

const CLAVES: readonly string[] = FONDOS_LOGIN.map((f) => f.clave);

/** Es una clave de la lista? Lo usan el CHECK de la base y el esquema de zod. */
export const esClaveFondo = (valor: string): valor is ClaveFondo => CLAVES.includes(valor);

/**
 * El fondo de un usuario, ya con su `url`.
 *
 * Si la clave guardada no esta en la lista (una base migrada a medias, o una
 * clave que se quito de la lista y la fila se quedo) devuelve el de por defecto
 * en vez de fallar. Es una preferencia decorativa: no vale la pena que una
 * imagen mal puesta deje a alguien sin poder entrar.
 */
export const fondoDe = (clave: string | null) => {
  const elegido = FONDOS_LOGIN.find((f) => f.clave === clave);
  if (elegido) return elegido;
  return FONDOS_LOGIN.find((f) => f.clave === FONDO_LOGIN_DEFECTO) ?? FONDOS_LOGIN[0];
};
