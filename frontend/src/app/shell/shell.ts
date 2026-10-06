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
  imports: [RouterOutlet, RouterLink, RouterLinkActive, ToastContainer],
  templateUrl: './shell.html',
  styleUrl: './shell.scss',
})
export class Shell {
  private readonly router = inject(Router);
  private readonly sesion = inject(Sesion);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly host = inject(ElementRef<HTMLElement>);

  /** Los grupos con lo que la persona puede ver, en el orden del catalogo. */
  readonly menu = computed(() => menuPara(new Set(this.sesion.perfil()?.permisos ?? [])));

  readonly nombre = computed(() => this.sesion.perfil()?.nombre ?? '');

  /** En celular el menu arranca cerrado, para que la pantalla sirva. */
  readonly menuAbierto = signal(false);

  /** Estado del sidebar: colapsado (solo iconos) vs expandido (iconos + texto) */
  readonly sidebarColapsado = signal(this.leerSidebarColapsado());

  /**
   * Solo lo que la persona cambio a mano.
   *
   * Antes este mapa se llenaba entero desde el `computed` del menu, y eso
   * tenía dos problemas: escribir una señal dentro de un `computed` no es
   * valido, y cada vez que llegaba el perfil se pisaba el estado y se
   * borraba lo que la persona habia colapsado a mano. Ahora el mapa solo
   * guarda lo que se toco, y lo demas lo resuelve `estaColapsado`.
   */
  readonly gruposColapsados = signal<Record<string, boolean>>({});

  /** Estado del dropdown del menu de sistema en la barra superior */
  readonly sistemaDropdownAbierto = signal(false);

  constructor() {
    // El ancho del menu es una preferencia, no un estado de la pantalla:
    // recargarla no deberia devolverla al ancho que la persona eligió.
    effect(() => this.guardarSidebarColapsado(this.sidebarColapsado()));
  }

  /** Obtiene el icono SVG como SafeHtml para usar con [innerHTML] */
  icono(nombre: string): SafeHtml {
    const svg = ICONOS[nombre] ?? ICONOS['clipboard'];
    return this.sanitizer.bypassSecurityTrustHtml(svg);
  }

  /** Opciones del menu Sistema (solo las que el usuario puede ver) */
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
        etiqueta: 'Auditoria',
        ruta: '/auditoria',
        icono: 'scroll',
        permiso: 'auditoria.ver',
      });
    }
    // Salir siempre esta disponible si hay sesion
    opciones.push({ etiqueta: 'Salir', ruta: '', icono: 'log-out', permiso: '' });

    return opciones;
  });

  /** Verifica si el usuario tiene permisos para ver el dropdown de Sistema */
  readonly puedeVerSistema = computed(() => {
    const permisos = new Set(this.sesion.perfil()?.permisos ?? []);
    return permisos.has('usuarios.ver') || permisos.has('auditoria.ver');
  });

  /** Cierra el menu de lado al elegir un modulo: en un celular tapar la pantalla es lo esperado. */
  cerrarMenu(): void {
    this.menuAbierto.set(false);
  }

  /** Alterna el estado colapsado del sidebar */
  alternarSidebar(): void {
    this.sidebarColapsado.update((v) => !v);
  }

  /** Alterna el dropdown del menu Sistema */
  alternarSistemaDropdown(): void {
    this.sistemaDropdownAbierto.update((v) => !v);
  }

  /** Cierra el dropdown del menu Sistema */
  cerrarSistemaDropdown(): void {
    this.sistemaDropdownAbierto.set(false);
  }

  /**
   * Cierra el dropdown de Sistema al hacer clic fuera de el.
   *
   * El clic del propio boton tambien llega aqui, asi que se mira de donde
   * salio: si viene de dentro del marco no se toca nada, porque ese clic lo
   * resuelve `alternarSistemaDropdown`. Sin esto el menu se quedaba abierto
   * con el raton en otro lado de la pantalla.
   */
  @HostListener('document:click', ['$event'])
  onClicFuera(event: MouseEvent): void {
    if (!this.sistemaDropdownAbierto()) return;
    const origen = event.target;
    if (origen instanceof Node && this.host.nativeElement.contains(origen)) return;
    this.cerrarSistemaDropdown();
  }

  /** Escape cierra lo que este abierto: el dropdown de Sistema o el menu de celular. */
  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.cerrarSistemaDropdown();
    this.menuAbierto.set(false);
  }

  /** Navega a una opcion del menu Sistema y cierra el dropdown */
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

  /** Si el grupo esta colapsado: lo que se toco a mano, o el valor del catalogo. */
  estaColapsado(grupo: Grupo): boolean {
    return this.gruposColapsados()[grupo.titulo] ?? grupo.colapsadoPorDefecto === true;
  }

  /**
   * El ancho elegido se recuerda entre recargas.
   *
   * Todo lo que usa `localStorage` va con `try`: en modo privado y en
   * algunos navegadores la escritura falla por cuota, y un menu que no se
   * dibuja porque no se pudo guardar una preferencia seria un costo enorme
   * por una cosa menor.
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
      /* si no se puede guardar, el menu igual funciona: solo no se acuerda */
    }
  }

  async salir(): Promise<void> {
    // Se limpia en el acto y sin esperar al backend: la navegacion sale en
    // el mismo clic y el `/auth/logout` va en segundo plano. Ver
    // `Sesion.salir`, que explica el trabazon que habia al esperarlo.
    this.sesion.salir();
    await this.router.navigate(['/login']);
  }
}
