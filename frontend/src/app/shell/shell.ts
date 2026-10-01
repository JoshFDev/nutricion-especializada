import { Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { menuPara, type Grupo } from '../nucleo/menu';
import { Sesion } from '../nucleo/sesion';
import { obtenerIcono } from '../nucleo/iconos/iconos';

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
  readonly menu = computed(() => {
    const grupos = menuPara(new Set(this.sesion.perfil()?.permisos ?? []));
    this.inicializarGruposColapsados(grupos);
    return grupos;
  });

  readonly nombre = computed(() => this.sesion.perfil()?.nombre ?? '');
  readonly puesto = computed(() => this.sesion.perfil()?.puesto ?? '');
  readonly email = computed(() => this.sesion.perfil()?.email ?? '');

  /** En celular el menu arranca cerrado, para que la pantalla sirva. */
  readonly menuAbierto = signal(false);

  /** Estado de grupos colapsables (Sistema, etc.) */
  readonly gruposColapsados = signal<Record<string, boolean>>({});

  /** Funcion para obtener iconos SVG en linea */
  readonly icono = obtenerIcono;

  /** Cierra el menu de lado al elegir un modulo: en un celular tapar la pantalla es lo esperado. */
  cerrarMenu(): void {
    this.menuAbierto.set(false);
  }

  /** Alterna un grupo colapsable */
  alternarGrupo(titulo: string): void {
    this.gruposColapsados.update((estado) => ({
      ...estado,
      [titulo]: !estado[titulo],
    }));
  }

  /** Verifica si un grupo esta colapsado */
  estaColapsado(titulo: string): boolean {
    return this.gruposColapsados()[titulo] === true;
  }

  /** Inicializa el estado colapsado para grupos que lo requieren */
  inicializarGruposColapsados(grupos: Grupo[]): void {
    const inicial: Record<string, boolean> = {};
    for (const grupo of grupos) {
      if (grupo.colapsable && grupo.colapsadoPorDefecto) {
        inicial[grupo.titulo] = true;
      }
    }
    if (Object.keys(inicial).length > 0) {
      this.gruposColapsados.set(inicial);
    }
  }

  async salir(): Promise<void> {
    await this.sesion.salir();
    await this.router.navigate(['/login']);
  }
}
