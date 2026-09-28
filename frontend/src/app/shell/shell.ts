import { Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { menuPara } from '../nucleo/menu';
import { Sesion } from '../nucleo/sesion';

/**
 * El marco de la app: cabecera, menu lateral y el hueco de la pantalla.
 *
 * No tiene NADA de la logica de los modulos. Solo dibuja, y quien decide
 * que se dibuje es `menu.ts` con los permisos que devolvio `/auth/yo`. Por
 * eso el menu se recalcula como `computed` y no en un `ngOnInit`: cuando
 * llega el perfil, la senal de permisos cambia y el menu sale solo, sin
 * que nadie tenga que mandarlo a redibujar.
 *
 * El menu se construye con `@for` sobre una lista y no con condicionales
 * sueltos: el filtro por permiso ya esta hecho en `menuPara`, y aqui solo
 * se pinta. Un `@if (sesion.puede('notas.ver'))` en el HTML obliga a
 * repetir el permiso cada vez que se agrega un modulo, y es la forma de que
 * se queden menus con entradas que el backend va a negar.
 */
@Component({
  selector: 'app-shell',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  templateUrl: './shell.html',
  styleUrl: './shell.scss',
})
export class Shell {
  private readonly router = inject(Router);
  private readonly sesion = inject(Sesion);

  /** Los grupos con lo que la persona puede ver, en el orden del catalogo. */
  readonly menu = computed(() => menuPara(new Set(this.sesion.perfil()?.permisos ?? [])));

  readonly nombre = computed(() => this.sesion.perfil()?.nombre ?? '');
  readonly puesto = computed(() => this.sesion.perfil()?.puesto ?? '');

  /** En celular el menu arranca cerrado, para que la pantalla sirva. */
  readonly menuAbierto = signal(false);

  /** Cierra el menu de lado al elegir un modulo: en un celular tapar la pantalla es lo esperado. */
  cerrarMenu(): void {
    this.menuAbierto.set(false);
  }

  async salir(): Promise<void> {
    await this.sesion.salir();
    await this.router.navigate(['/login']);
  }
}
