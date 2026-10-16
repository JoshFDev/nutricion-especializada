import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  computed,
  inject,
  signal,
} from '@angular/core';
import { DomSanitizer, type SafeHtml } from '@angular/platform-browser';
import { RouterLink } from '@angular/router';
import { ATAJOS } from '../nucleo/ayuda';
import { ICONOS } from '../nucleo/iconos/iconos';
import { INFO_SISTEMA } from '../nucleo/info';
import { menuPara } from '../nucleo/menu';
import { Sesion } from '../nucleo/sesion';

/** Los cuatro paneles que cuelgan del botón de ayuda. */
type Seccion = 'guia' | 'atajos' | 'soporte' | 'acerca';

/**
 * El botón de Ayuda de la barra: su menú y sus ventanas.
 *
 * Es el "?" de al lado del engrane, y trae las cuatro cosas que se preguntan
 * de un sistema que no se conoce: qué hace cada sección, qué atajos hay, a
 * dónde escribir si algo falla y qué versión es esta.
 *
 * La guía NO es una lista escrita aparte: sale del mismo catálogo del menú
 * (`menuPara`), así que solo muestra lo que la persona puede abrir y un módulo
 * nuevo aparece aquí solo. El texto de cada uno vive en `menu.ts` (`ayuda`).
 *
 * Todo el estado del botón vive aquí: el menú desplegable, el panel abierto y
 * el cierre al hacer clic fuera o con Escape. El shell solo lo coloca en la
 * barra.
 */
@Component({
  selector: 'app-ayuda',
  templateUrl: './ayuda.html',
  styleUrl: './ayuda.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
})
export class Ayuda {
  private readonly sesion = inject(Sesion);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly host = inject(ElementRef<HTMLElement>);

  readonly info = INFO_SISTEMA;
  readonly atajos = ATAJOS;
  readonly anio = new Date().getFullYear();

  /** El título de cada panel, por llave. */
  readonly titulos: Record<Seccion, string> = {
    guia: 'Guía rápida',
    atajos: 'Atajos de teclado',
    soporte: 'Soporte',
    acerca: 'Acerca de',
  };

  readonly menuAbierto = signal(false);

  /** El panel abierto, o `null` si no hay ninguno. */
  readonly seccion = signal<Seccion | null>(null);

  /**
   * La guía: los grupos y módulos que la persona puede ver, con su ayuda.
   *
   * Es la misma lista del menú lateral, así que respeta permisos y orden, y
   * nunca ofrece una sección que al abrirla daría "sin permiso".
   */
  readonly guia = computed(() => menuPara(new Set(this.sesion.perfil()?.permisos ?? [])));

  icono(nombre: string): SafeHtml {
    const svg = ICONOS[nombre] ?? ICONOS['clipboard'];
    return this.sanitizer.bypassSecurityTrustHtml(svg);
  }

  alternarMenu(): void {
    this.menuAbierto.update((abierto) => !abierto);
  }

  /** Abre un panel y, de paso, cierra el menú desplegable. */
  abrir(seccion: Seccion): void {
    this.menuAbierto.set(false);
    this.seccion.set(seccion);
  }

  cerrar(): void {
    this.seccion.set(null);
  }

  /**
   * Cierra el menú al hacer clic fuera de este componente.
   *
   * Cuelga del `document` y no del botón porque un clic en cualquier otra
   * parte de la pantalla tiene que cerrarlo. El propio botón queda dentro de
   * `this.host`, así que ese clic se ignora aquí y lo resuelve
   * `alternarMenu`.
   */
  @HostListener('document:click', ['$event'])
  alClicFuera(evento: MouseEvent): void {
    if (!this.menuAbierto()) return;
    const origen = evento.target;
    if (origen instanceof Node && this.host.nativeElement.contains(origen)) return;
    this.menuAbierto.set(false);
  }

  /** Escape cierra primero el panel y, si no hay panel, el menú. */
  @HostListener('document:keydown.escape')
  alEscape(): void {
    if (this.seccion() !== null) {
      this.cerrar();
      return;
    }
    this.menuAbierto.set(false);
  }
}
