import type { Routes } from '@angular/router';
import { guardaInicio, guardaPermiso, guardaSesion, guardaSinSesion } from './nucleo/guarda-sesion';
import { MODULOS } from './nucleo/menu';

/**
 * Las rutas de la app.
 *
 * Las de los modulos NO se escriben aqui una por una: se generan de
 * `MODULOS`, la misma tabla de la que sale el menu lateral. Es lo que evita
 * que las dos cosas se separen con el tiempo, que es como un menu acaba
 * ofreciendo un modulo que da 404, o de que exista una ruta que no aparece
 * en ninguna parte.
 *
 * Todas las pantallas van con `loadComponent` y no en un `NgModule`: no hay
 * NgModules en el proyecto, y el bundle inicial se queda con el shell y
 * nada mas. A la gente que le carga el mostrador no le baja el codigo del
 * modulo de auditoria.
 */
export const routes: Routes = [
  {
    path: 'login',
    canActivate: [guardaSinSesion],
    loadComponent: () => import('./auth/login').then((m) => m.Login),
  },
  {
    path: 'cambiar-contrasena',
    canActivate: [guardaSesion],
    loadComponent: () => import('./auth/cambiar-contrasena').then((m) => m.CambiarContrasena),
  },
  {
    path: 'sin-conexion',
    loadComponent: () => import('./shell/sin-conexion').then((m) => m.SinConexion),
  },

  // Todo lo de adentro del shell lleva sesion. La guarda del padre cubre
  // a los hijos: no hay que repetirla en cada ruta.
  {
    path: '',
    canActivate: [guardaSesion],
    loadComponent: () => import('./shell/shell').then((m) => m.Shell),
    children: [
      // Raiz: a donde la persona puede entrar de verdad. `guardaInicio`
      // devuelve una redireccion, asi que este componente solo se ve cuando
      // NO hay ningun modulo, y entonces explica eso.
      {
        path: '',
        pathMatch: 'full',
        canActivate: [guardaInicio],
        loadComponent: () => import('./shell/sin-modulos').then((m) => m.SinModulos),
      },
      {
        path: 'sin-permisos',
        loadComponent: () => import('./shell/sin-permisos').then((m) => m.SinPermisos),
      },
      ...rutasDeModulos(),
    ],
  },

  // Cualquier cosa que no exista cae en el inicio. Sin esto, una URL mal
  // escrita se queda en blanco y parece que la app se cayo.
  { path: '**', redirectTo: '' },
];

/**
 * Una ruta por modulo, con su permiso en el `data` para `guardaPermiso`.
 *
 * El `data` tambien lleva el texto de "pantalla pendiente", que es lo que
 * lee `Pendiente` para no tener el modulo hardcodeado en la pantalla.
 */
function rutasDeModulos(): Routes {
  return MODULOS.map((modulo) => ({
    path: modulo.ruta,
    canActivate: [guardaPermiso],
    data: {
      permiso: modulo.permiso,
      etiqueta: modulo.etiqueta,
      pendiente: modulo.pendiente,
    },
    loadComponent: () => import('./shell/pendiente').then((m) => m.Pendiente),
  }));
}
