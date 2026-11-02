import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
  viewChild,
  type OnInit,
} from '@angular/core';
import { ConfirmModal } from '../productos/confirm-modal';
import { Sesion } from '../nucleo/sesion';
import { ToastService } from '../nucleo/toast.service';
import {
  abrirCarpetaRespaldos,
  crearRespaldo,
  fechaLegible,
  listarRespaldos,
  respaldosDisponibles,
  restaurarRespaldo,
  tamanoLegible,
  type Respaldo,
  type TipoRespaldo,
} from '../nucleo/respaldos';

/**
 * La pantalla de Respaldos.
 *
 * Aqui no hay API HTTP: los respaldos viven en el proceso principal de
 * Electron porque son archivos y porque restaurar tiene que poder cerrar el
 * backend y relanzar la aplicacion. La pantalla solo pide las cuatro
 * operaciones que expone `preload.ts`.
 *
 * Lo importante de la pantalla es lo que DICE antes de una restauracion:
 * que se reemplaza toda la base, que hay un respaldo de seguridad y que la
 * aplicacion se va a reiniciar. Un boton rojo sin esa explicacion no es una
 * confirmacion, es una trampa.
 */
@Component({
  selector: 'app-respaldos',
  templateUrl: './respaldos.html',
  styleUrl: './respaldos.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ConfirmModal],
})
export class Respaldos implements OnInit {
  private readonly sesion = inject(Sesion);
  private readonly toast = inject(ToastService);

  readonly confirmModal = viewChild.required(ConfirmModal);

  /** Si esta corriendo dentro de la app de escritorio. */
  readonly disponible = respaldosDisponibles();

  readonly puedeGestionar = computed(() => this.sesion.puede('respaldos.gestionar'));

  readonly respaldos = signal<Respaldo[]>([]);
  readonly cargando = signal(true);
  readonly error = signal<string | null>(null);
  readonly trabajando = signal<'crear' | 'restaurar' | null>(null);

  /** El ultimo respaldo automatico, para el resumen de arriba. */
  readonly ultimoAutomatico = computed(
    () => this.respaldos().find((respaldo) => respaldo.tipo === 'automatico') ?? null,
  );

  readonly total = computed(() => this.respaldos().length);

  ngOnInit(): void {
    void this.cargar();
  }

  async cargar(): Promise<void> {
    this.cargando.set(true);
    this.error.set(null);
    try {
      this.respaldos.set(await listarRespaldos());
    } catch (fallo) {
      this.error.set(this.mensaje(fallo));
    } finally {
      this.cargando.set(false);
    }
  }

  async crear(): Promise<void> {
    if (!this.puedeGestionar() || this.trabajando() !== null) return;

    this.trabajando.set('crear');
    try {
      const respaldo = await crearRespaldo();
      this.toast.exito(`Respaldo creado: ${respaldo.nombre}`);
      await this.cargar();
    } catch (fallo) {
      this.toast.error(this.mensaje(fallo));
    } finally {
      this.trabajando.set(null);
    }
  }

  async restaurar(respaldo: Respaldo): Promise<void> {
    if (!this.puedeGestionar() || this.trabajando() !== null) return;

    const confirmado = await this.confirmModal().abrir({
      titulo: 'Restaurar un respaldo',
      mensaje:
        `Se va a reemplazar TODA la base de datos con el contenido de ` +
        `${respaldo.nombre} (${this.fecha(respaldo.creadoEn)}). ` +
        'Todo lo que se haya capturado despues de esa fecha se pierde.',
      textoConfirmar: 'Restaurar y reiniciar',
      variante: 'peligro',
      detalles: [
        'Antes de restaurar se crea un respaldo de seguridad de lo que hay ahora.',
        'Si la restauracion falla, la base queda exactamente como esta y no se pierde nada.',
        'Al terminar, la aplicacion se cierra y se vuelve a abrir sola.',
      ],
    });

    if (!confirmado) return;

    this.trabajando.set('restaurar');
    try {
      const resultado = await restaurarRespaldo(respaldo.nombre);
      this.toast.info(
        `Restauracion completada (${resultado.filas} filas). La aplicacion se reiniciara...`,
      );
    } catch (fallo) {
      this.toast.error(this.mensaje(fallo));
      this.trabajando.set(null);
    }
  }

  async abrirCarpeta(): Promise<void> {
    try {
      await abrirCarpetaRespaldos();
    } catch (fallo) {
      this.toast.error(this.mensaje(fallo));
    }
  }

  fecha(iso: string): string {
    return fechaLegible(iso);
  }

  tamano(bytes: number): string {
    return tamanoLegible(bytes);
  }

  tipo(tipo: TipoRespaldo): string {
    switch (tipo) {
      case 'automatico':
        return 'Automatico';
      case 'seguridad':
        return 'Seguridad';
      default:
        return 'Manual';
    }
  }

  /**
   * Los errores de IPC llegan como `Error` normal, no como `HttpErrorResponse`.
   * El mensaje ya viene escrito para la persona desde `main.ts`, asi que se
   * muestra tal cual; si no es un Error, se usa un texto generico.
   */
  private mensaje(fallo: unknown): string {
    if (fallo instanceof Error && fallo.message.trim() !== '') return fallo.message;
    return 'No se pudo completar la operacion con los respaldos.';
  }
}
