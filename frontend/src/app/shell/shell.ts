import { Component, HostListener, computed, effect, inject, signal, Renderer2 } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { DomSanitizer, type SafeHtml } from '@angular/platform-browser';
import { menuPara, modulosSistema, type Grupo } from '../nucleo/menu';
import { Sesion } from '../nucleo/sesion';
import { ICONOS } from '../nucleo/iconos/iconos';
import { ToastContainer } from '../nucleo/toast';
import { Ayuda } from './ayuda';

const ZOOM_MIN = 0.8;
const ZOOM_MAX = 1.5;
const ZOOM_STEP = 0.1;

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
  imports: [RouterOutlet, RouterLink, RouterLinkActive, ToastContainer, Ayuda],
  templateUrl: './shell.html',
  styleUrl: './shell.scss',
})
export class Shell {
  private readonly router = inject(Router);
  private readonly sesion = inject(Sesion);
  private readonly sanitizer = inject(DomSanitizer);

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

  /** Nivel de zoom actual (1 = 100%, valores entre 0.8 y 1.5) */
  readonly zoom = signal(1);

  constructor(private readonly renderer: Renderer2) {
    // El ancho del menú es una preferencia, no un estado de la pantalla:
    // recargarla no debería devolverla al ancho que la persona eligió.
    effect(() => this.guardarSidebarColapsado(this.sidebarColapsado()));
    // Cargar zoom guardado o valor por defecto
    try {
      const guardado = localStorage.getItem('app:zoom');
      if (guardado) {
        this.zoom.set(parseFloat(guardado));
        this.aplicarZoom();
      }
    } catch {
      /* si no se puede leer, usa el valor por defecto */
    }
  }

  /** Aplica el nivel de zoom actual al elemento raíz */
  private aplicarZoom(): void {
    try {
      const factor = this.zoom();
      this.renderer.setStyle(document.documentElement, 'zoom', String(factor));
      this.renderer.removeStyle(document.documentElement, 'transform');
      this.renderer.removeStyle(document.documentElement, 'transformOrigin');
    } catch {
      try {
        this.renderer.setStyle(document.documentElement, 'transformOrigin', '0 0');
        this.renderer.setStyle(document.documentElement, 'transform', `scale(${this.zoom()})`);
      } catch {
        /* si falla, el zoom igual funciona */
      }
    }
  }

  /** Aumenta el zoom en un paso, limitado al máximo */
  zoomIn(): void {
    this.zoom.update((v) => {
      const nuevo = Math.min(ZOOM_MAX, v + ZOOM_STEP);
      if (nuevo !== v) {
        this.guardarZoom(nuevo);
        this.aplicarZoom();
      }
      return nuevo;
    });
  }

  /** Disminuye el zoom en un paso, limitado al mínimo */
  zoomOut(): void {
    this.zoom.update((v) => {
      const nuevo = Math.max(ZOOM_MIN, v - ZOOM_STEP);
      if (nuevo !== v) {
        this.guardarZoom(nuevo);
        this.aplicarZoom();
      }
      return nuevo;
    });
  }

  /** Guarda el nivel de zoom en localStorage */
  private guardarZoom(valor: number): void {
    try {
      localStorage.setItem('app:zoom', valor.toString());
    } catch {
      /* si no se puede guardar, el zoom igual funciona */
    }
  }

  /** Obtiene el icono SVG como SafeHtml para usar con [innerHTML] */
  icono(nombre: string): SafeHtml {
    const svg = ICONOS[nombre] ?? ICONOS['clipboard'];
    return this.sanitizer.bypassSecurityTrustHtml(svg);
  }

  /**
   * Opciones del menú Sistema (solo las que el usuario puede ver).
   *
   * Salen de la MISMA tabla del menú lateral (`modulosSistema`, el grupo
   * "Sistema") y no de una copia a mano: ese grupo no se dibuja en el
   * lateral y este desplegable es su única puerta, así que una copia que se
   * atrasa deja un módulo sin forma de abrirlo. "Salir" es la única que no es
   * un módulo y se agrega aparte.
   */
  readonly sistemaOpciones = computed(() => {
    const permisos = new Set(this.sesion.perfil()?.permisos ?? []);
    const opciones: { etiqueta: string; ruta: string; icono: string; permiso: string }[] =
      modulosSistema(permisos).map((modulo) => ({
        etiqueta: modulo.etiqueta,
        ruta: `/${modulo.ruta}`,
        icono: modulo.icon,
        permiso: modulo.permiso,
      }));

    // Salir siempre está disponible si hay sesión
    opciones.push({ etiqueta: 'Salir', ruta: '', icono: 'log-out', permiso: '' });

    return opciones;
  });

  /** Verifica si el usuario tiene permisos para ver el desplegable de Sistema */
  readonly puedeVerSistema = computed(() => {
    const permisos = new Set(this.sesion.perfil()?.permisos ?? []);
    return modulosSistema(permisos).length > 0;
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
   * salió: si viene de dentro del desplegable no se toca nada, porque ese clic
   * lo resuelve `alternarSistemaDropdown`. Sin esto el menú se quedaba abierto
   * con el ratón en otro lado de la pantalla, y hasta al abrir la Ayuda de al
   * lado (que es otro desplegable) los dos quedaban abiertos a la vez.
   */
  @HostListener('document:click', ['$event'])
  onClicFuera(event: MouseEvent): void {
    if (!this.sistemaDropdownAbierto()) return;
    const origen = event.target;
    if (origen instanceof Element && origen.closest('.sistema-dropdown') !== null) return;
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
