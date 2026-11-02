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
  cambiarCarpetaRespaldos,
  crearRespaldo,
  fechaLegible,
  guardarHorarioRespaldos,
  listarRespaldos,
  obtenerCarpetaRespaldos,
  obtenerHorarioRespaldos,
  obtenerSaludRespaldos,
  respaldosDisponibles,
  restaurarRespaldo,
  tamanoLegible,
  validarIntegridad,
  type HorarioRespaldos,
  type Respaldo,
  type ResultadoSaludRespaldos,
  type ResultadoValidacion,
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
  readonly trabajando = signal<'crear' | 'restaurar' | 'validar' | 'cambiar-carpeta' | null>(null);

  /** Carpeta actual donde se guardan los respaldos. */
  readonly carpetaRespaldos = signal<string>('');

  /** Horario de respaldos programados. */
  readonly horarioRespaldos = signal<HorarioRespaldos>({
    activo: false,
    hora: 20,
    minuto: 0,
    diasSemana: [0, 1, 2, 3, 4, 5, 6],
  });

  /** Si se esta guardando el horario. */
  readonly guardandoHorario = signal(false);

  /** Estado de salud de los respaldos. */
  readonly saludRespaldos = signal<ResultadoSaludRespaldos | null>(null);

  /** Estado de validacion de integridad por nombre de respaldo. */
  readonly validaciones = signal<
    Record<string, { valido: boolean | null; errores: string[]; verificando: boolean }>
  >({});

  /** El ultimo respaldo automatico, para el resumen de arriba. */
  readonly ultimoAutomatico = computed(
    () => this.respaldos().find((respaldo) => respaldo.tipo === 'automatico') ?? null,
  );

  readonly total = computed(() => this.respaldos().length);

  ngOnInit(): void {
    void this.cargar();
    void this.cargarCarpeta();
    void this.cargarHorario();
    void this.cargarSalud();
  }

  async cargarSalud(): Promise<void> {
    try {
      const salud = await obtenerSaludRespaldos();
      this.saludRespaldos.set(salud);
    } catch {
      // Si falla, se queda sin estado de salud.
    }
  }

  async cargarCarpeta(): Promise<void> {
    try {
      const carpeta = await obtenerCarpetaRespaldos();
      this.carpetaRespaldos.set(carpeta);
    } catch {
      // Si falla, se queda vacia y la UI muestra el valor por defecto.
    }
  }

  async cambiarCarpeta(): Promise<void> {
    if (this.trabajando() !== null) return;

    this.trabajando.set('cambiar-carpeta');
    try {
      const carpeta = await cambiarCarpetaRespaldos();
      this.carpetaRespaldos.set(carpeta);
      this.toast.exito(`Carpeta de respaldos actualizada: ${carpeta}`);
      await this.cargar();
    } catch (fallo) {
      if ((fallo as Error)?.message?.includes('selecciono')) {
        // El usuario cancelo: no es un error.
      } else {
        this.toast.error(this.mensaje(fallo));
      }
    } finally {
      this.trabajando.set(null);
    }
  }

  async cargarHorario(): Promise<void> {
    try {
      const horario = await obtenerHorarioRespaldos();
      this.horarioRespaldos.set(horario);
    } catch {
      // Si falla, se queda con los valores por defecto.
    }
  }

  async guardarHorario(): Promise<void> {
    if (this.guardandoHorario()) return;

    this.guardandoHorario.set(true);
    try {
      const guardado = await guardarHorarioRespaldos(this.horarioRespaldos());
      this.horarioRespaldos.set(guardado);
      this.toast.exito(`Respaldos programados ${guardado.activo ? 'activados' : 'desactivados'}.`);
    } catch (fallo) {
      this.toast.error(this.mensaje(fallo));
    } finally {
      this.guardandoHorario.set(false);
    }
  }

  /** Nombre corto del dia de la semana para mostrar en la UI. */
  diaSemanaNombre(dia: number): string {
    const nombres = ['Dom', 'Lun', 'Mar', 'Mie', 'Jue', 'Vie', 'Sab'];
    return nombres[dia] ?? String(dia);
  }

  /** Si un dia de la semana esta seleccionado en el horario. */
  diaSeleccionado(dia: number): boolean {
    return this.horarioRespaldos().diasSemana.includes(dia);
  }

  /** Toggle de un dia de la semana en el horario. */
  toggleDia(dia: number): void {
    const horario = { ...this.horarioRespaldos() };
    const indice = horario.diasSemana.indexOf(dia);
    if (indice >= 0) {
      horario.diasSemana = horario.diasSemana.filter((d) => d !== dia);
    } else {
      horario.diasSemana = [...horario.diasSemana, dia].sort((a, b) => a - b);
    }
    this.horarioRespaldos.set(horario);
  }

  /** Icono para el estado de salud del respaldo. */
  iconoSalud(estado: ResultadoSaludRespaldos['estado']): string {
    switch (estado) {
      case 'saludable':
        return '●';
      case 'advertencia':
        return '●';
      case 'critico':
        return '●';
    }
  }

  /** Actualiza la hora del horario desde un input. */
  actualizarHora(valor: string): void {
    const horario = { ...this.horarioRespaldos() };
    horario.hora = Math.max(0, Math.min(23, parseInt(valor, 10) || 0));
    this.horarioRespaldos.set(horario);
  }

  /** Actualiza el minuto del horario desde un input. */
  actualizarMinuto(valor: string): void {
    const horario = { ...this.horarioRespaldos() };
    horario.minuto = Math.max(0, Math.min(59, parseInt(valor, 10) || 0));
    this.horarioRespaldos.set(horario);
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

  async validar(respaldo: Respaldo): Promise<void> {
    if (this.trabajando() !== null) return;

    this.trabajando.set('validar');
    const anterior = this.validaciones();
    this.validaciones.set({
      ...anterior,
      [respaldo.nombre]: { valido: null, errores: [], verificando: true },
    });

    try {
      const resultado = await validarIntegridad(respaldo.nombre);
      this.validaciones.set({
        ...anterior,
        [respaldo.nombre]: {
          valido: resultado.valido,
          errores: resultado.errores,
          verificando: false,
        },
      });

      if (resultado.valido) {
        this.toast.exito('El respaldo es valido y se puede restaurar.');
      } else {
        this.toast.error('El respaldo no es valido: ' + resultado.errores.join('; '));
      }
    } catch (fallo) {
      this.toast.error(this.mensaje(fallo));
      this.validaciones.set({
        ...anterior,
        [respaldo.nombre]: {
          valido: null,
          errores: [this.mensaje(fallo)],
          verificando: false,
        },
      });
    } finally {
      if (this.trabajando() === 'validar') this.trabajando.set(null);
    }
  }

  async restaurar(respaldo: Respaldo): Promise<void> {
    if (!this.puedeGestionar() || this.trabajando() !== null) return;

    // Validar integridad antes de permitir la restauracion.
    const previa = this.validaciones()[respaldo.nombre];
    if (!previa?.valido) {
      await this.validar(respaldo);
      const despues = this.validaciones()[respaldo.nombre];
      if (!despues?.valido) return;
    }

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

  /** Estado de validacion de un respaldo para mostrar en la plantilla. */
  estadoValidacion(nombre: string) {
    return this.validaciones()[nombre] ?? null;
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
