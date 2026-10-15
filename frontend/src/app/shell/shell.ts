import {
  Component,
  ElementRef,
  HostListener,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { DomSanitizer, type SafeHtml } from '@angular/platform-browser';
import { menuPara, type Grupo } from '../nucleo/menu';
import { Sesion } from '../nucleo/sesion';
import { ICONOS } from '../nucleo/iconos/iconos';
import { ToastContainer } from '../nucleo/toast';

/**
 * El marco de la aplicación: cabecera, menú lateral y el hueco de la pantalla.
 *
 * No tiene NADA de la lógica de los módulos. Solo dibuja, y quien decide qué se
 * dibuja es `menu.ts` con los permisos que devolvió `/auth/yo`. Por eso el menú
 * se recalcula como `computed` y no en un `ngOnInit`: cuando llega el perfil,
 * la señal de permisos cambia y el menú sale solo, sin que nadie tenga que
 * mandarlo a redibujar.
 *
 * El menú se construye con `@for` sobre una lista y no con condicionales
 * sueltos: el filtro por permiso ya está hecho en `menuPara`, y aquí solo se
 * pinta. Un `@if (sesion.puede('notas.ver'))` en el HTML obliga a repetir el
 * permiso cada vez que se agrega un módulo, y es la forma de que se queden
 * menús con entradas que el sistema va a negar.
 */
@Component({
  selector: 'app-shell',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, ToastContainer],
  templateUrl: './shell.html',
  styleUrl: './shell.scss',
})
export class Shell {
  private readonly router = inject(Router);
  private readonly sesion = inject(Sesion);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly host = inject(ElementRef<HTMLElement>);

  /** Los grupos con lo que la persona puede ver, en el orden del catálogo. */
  readonly menu = computed(() => menuPara(new Set(this.sesion.perfil()?.permisos ?? [])));

  readonly nombre = computed(() => this.sesion.perfil()?.nombre ?? '');

  /** En celular el menú arranca cerrado, para que la pantalla sirva. */
  readonly menuAbierto = signal(false);

  /** Estado del menú lateral: colapsado (solo iconos) vs expandido (iconos + texto) */
  readonly sidebarColapsado = signal(this.leerSidebarColapsado());

  /**
   * Solo lo que la persona cambió a mano.
   *
   * Antes este mapa se llenaba entero desde el `computed` del menú, y eso tenía
   * dos problemas: escribir una señal dentro de un `computed` no es válido, y
   * cada vez que llegaba el perfil se pisaba el estado y se borraba lo que la
   * persona había colapsado a mano. Ahora el mapa solo guarda lo que se tocó, y
   * lo demás lo resuelve `estaColapsado`.
   */
  readonly gruposColapsados = signal<Record<string, boolean>>({});

  /** Estado del desplegable del menú de sistema en la barra superior */
  readonly sistemaDropdownAbierto = signal(false);

  constructor() {
    // El ancho del menú es una preferencia, no un estado de la pantalla:
    // recargarla no debería devolverla al ancho que la persona eligió.
    effect(() => this.guardarSidebarColapsado(this.sidebarColapsado()));
  }

  /** Obtiene el icono SVG como SafeHtml para usar con [innerHTML] */
  icono(nombre: string): SafeHtml {
    const svg = ICONOS[nombre] ?? ICONOS['clipboard'];
    return this.sanitizer.bypassSecurityTrustHtml(svg);
  }

  /** Opciones del menú Sistema (solo las que el usuario puede ver) */
  readonly sistemaOpciones = computed(() => {
    const permisos = new Set(this.sesion.perfil()?.permisos ?? []);
    const opciones: { etiqueta: string; ruta: string; icono: string; permiso: string }[] = [];

    if (permisos.has('usuarios.ver')) {
      opciones.push({
        etiqueta: 'Usuarios y roles',
        ruta: '/usuarios',
        icono: 'user-cog',
        permiso: 'usuarios.ver',
      });
    }
    if (permisos.has('auditoria.ver')) {
      opciones.push({
        etiqueta: 'Auditoría',
        ruta: '/auditoria',
        icono: 'scroll',
        permiso: 'auditoria.ver',
      });
    }
    // Salir siempre está disponible si hay sesión
    opciones.push({ etiqueta: 'Salir', ruta: '', icono: 'log-out', permiso: '' });

    return opciones;
  });

  /** Verifica si el usuario tiene permisos para ver el desplegable de Sistema */
  readonly puedeVerSistema = computed(() => {
    const permisos = new Set(this.sesion.perfil()?.permisos ?? []);
    return permisos.has('usuarios.ver') || permisos.has('auditoria.ver');
  });

  /** Cierra el menú de lado al elegir un módulo: en un celular tapar la pantalla es lo esperado. */
  cerrarMenu(): void {
    this.menuAbierto.set(false);
  }

  /** Alterna el estado colapsado del menú lateral */
  alternarSidebar(): void {
    this.sidebarColapsado.update((v) => !v);
  }

  /** Alterna el desplegable del menú Sistema */
  alternarSistemaDropdown(): void {
    this.sistemaDropdownAbierto.update((v) => !v);
  }

  /** Cierra el desplegable del menú Sistema */
  cerrarSistemaDropdown(): void {
    this.sistemaDropdownAbierto.set(false);
  }

  /**
   * Cierra el desplegable de Sistema al hacer clic fuera de él.
   *
   * El clic del propio botón también llega aquí, así que se mira de dónde
   * salió: si viene de dentro del marco no se toca nada, porque ese clic lo
   * resuelve `alternarSistemaDropdown`. Sin esto el menú se quedaba abierto con
   * el ratón en otro lado de la pantalla.
   */
  @HostListener('document:click', ['$event'])
  onClicFuera(event: MouseEvent): void {
    if (!this.sistemaDropdownAbierto()) return;
    const origen = event.target;
    if (origen instanceof Node && this.host.nativeElement.contains(origen)) return;
    this.cerrarSistemaDropdown();
  }

  /** Escape cierra lo que esté abierto: el desplegable de Sistema o el menú de celular. */
  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.cerrarSistemaDropdown();
    this.menuAbierto.set(false);
  }

  /** Navega a una opción del menú Sistema y cierra el desplegable */
  async irAOpcion(opcion: {
    etiqueta: string;
    ruta: string;
    icono: string;
    permiso: string;
  }): Promise<void> {
    this.cerrarSistemaDropdown();
    if (opcion.ruta === '') {
      await this.salir();
    } else {
      await this.router.navigate([opcion.ruta]);
    }
  }

  /** Alterna un grupo colapsable */
  alternarGrupo(grupo: Grupo): void {
    this.gruposColapsados.update((estado) => ({
      ...estado,
      [grupo.titulo]: !this.estaColapsado(grupo),
    }));
  }

  /** Si el grupo está colapsado: lo que se tocó a mano, o el valor del catálogo. */
  estaColapsado(grupo: Grupo): boolean {
    return this.gruposColapsados()[grupo.titulo] ?? grupo.colapsadoPorDefecto === true;
  }

  /**
   * El ancho elegido se recuerda entre recargas.
   *
   * Todo lo que usa `localStorage` va con `try`: en modo privado y en algunos
   * navegadores la escritura falla por cuota, y un menú que no se dibuja porque
   * no se pudo guardar una preferencia sería un costo enorme por una cosa
   * menor.
   */
  private leerSidebarColapsado(): boolean {
    try {
      return localStorage.getItem('sidebar:colapsado') === '1';
    } catch {
      return false;
    }
  }

  private guardarSidebarColapsado(valor: boolean): void {
    try {
      localStorage.setItem('sidebar:colapsado', valor ? '1' : '0');
    } catch {
      /* si no se puede guardar, el menú igual funciona: solo no se acuerda */
    }
  }

  async salir(): Promise<void> {
    // Se limpia en el acto y sin esperar al sistema: la navegación sale en el
    // mismo clic y el `/auth/logout` va en segundo plano. Ver `Sesion.salir`,
    // que explica el enredo que había al esperarlo.
    this.sesion.salir();
    await this.router.navigate(['/login']);
  }
}
