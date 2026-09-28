import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { errorLegible } from '../nucleo/api';
import { Sesion } from '../nucleo/sesion';
import { montoComoTexto } from '../nucleo/cifras';
import {
  cuerpoDePago,
  hoyComoTexto,
  montoDeAplicaciones,
  problemaDeAplicacion,
  PagosApi,
  METODOS_PAGO,
  type AplicacionEditor,
  type MetodoPago,
  type Pago,
  type PagoListado,
} from './pagos-api';

/**
 * La cobranza: qué se cobró, a qué notas y cómo.
 *
 * Es la pantalla de MOSTRADOR de los pagos — mismo ánimo que el POS pero de
 * dinero en vez de producto. Dos pasos en una vista:
 *
 *   1. El listado: quién pagó, cuándo, por cuánto, y con qué método. El
 *      pago NO se puede borrar ni corregir (el backend no tiene PATCH ni
 *      DELETE; un pago en mal estado se arregla cancelando la nota que
 *      cobraba, no borrando), así que aquí no hay edición: hay Ver.
 *   2. El editor: se elige el cliente, se captura método y monto, y se le
 *      aplica a las notas abiertas. Un pago sin aplicaciones es un abono a
 *      cuenta, y es válido; el saldo (monto - aplicado) se ve mientras se
 *      captura y la base lo recalcula al guardar.
 *
 * Cada aplicación se valida DOS veces, como en el POS: aquí con el subtotal
 * (el editor sabe cuánto vale cada nota), y en el backend contra el saldo
 * REAL de la nota (una parcial ya trae cobrado). Es el mismo acuerdo de
 * `problemaDeAplicacion`: el frontend avisa lo que puede y el backend
 * comprueba lo que sabe.
 */
@Component({
  selector: 'app-pagos',
  templateUrl: './pagos.html',
  styleUrl: './pagos.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Pagos {
  private readonly api = inject(PagosApi);
  private readonly sesion = inject(Sesion);

  // ------------------------------------------------------------- el listado
  readonly listado = signal<PagoListado[]>([]);
  readonly total = signal(0);
  readonly offset = signal(0);
  readonly limite = 50;
  readonly cargandoLista = signal(false);
  readonly buscandoMas = signal(false);
  readonly errorLista = signal<string | null>(null);

  readonly buscar = signal('');
  readonly metodo = signal<'' | MetodoPago>('');
  readonly desde = signal('');
  readonly hasta = signal('');

  /** El detalle que se ve encima de la lista; vacío es "no hay ninguna abierta". */
  readonly detalle = signal<Pago | null>(null);
  readonly cargandoDetalle = signal(false);

  readonly puedeCrear = computed(() => this.sesion.puede('pagos.crear'));
  readonly hayMas = computed(() => this.listado().length < this.total());

  // -------------------------------------------------------------- el editor
  /** `null` es "mostrar el listado" y `true` es "capturar un pago". */
  private conEditor = signal(false);
  readonly editorAbierto = this.conEditor.asReadonly();

  readonly cliente = signal<{ id: number; nombre: string } | null>(null);
  readonly resultadosCliente = signal<{ id: number; nombre: string }[]>([]);
  readonly buscandoCliente = signal(false);
  readonly cargandoNotas = signal(false);

  readonly fecha = signal(hoyComoTexto());
  readonly metodoPago = signal<'' | MetodoPago>('');
  readonly monto = signal('');
  readonly referencia = signal('');
  readonly requiereFactura = signal(false);
  readonly aplicaciones = signal<AplicacionEditor[]>([]);

  readonly guardando = signal(false);
  readonly error = signal<string | null>(null);

  // ------------------------------------------------------- la derivada
  readonly aplicado = computed(() => montoDeAplicaciones(this.aplicaciones()));
  readonly montoNumero = computed(() => {
    const numero = Number(this.monto().trim().replace(',', '.'));
    return Number.isFinite(numero) ? numero : 0;
  });
  /** Lo que no queda aplicado: el preview del abono a cuenta. */
  readonly saldo = computed(() => Math.max(this.montoNumero() - this.aplicado(), 0));
  /** Aplicar más de lo capturado no se puede: el pago no alcanza. */
  readonly alcanza = computed(
    () => this.aplicaciones().length === 0 || this.aplicado() <= this.montoNumero(),
  );

  readonly puedeGuardar = computed(
    () =>
      this.puedeCrear() &&
      this.cliente() !== null &&
      this.montoNumero() > 0 &&
      this.aplicaciones().every((a) => problemaDeAplicacion(a) === null) &&
      this.alcanza() &&
      !this.guardando(),
  );

  // ------------------------------------------------------------ la búsqueda
  private temporizadorCliente: ReturnType<typeof setTimeout> | undefined;
  /** Sin confirmar el texto, tras 250 ms para no buscar en cada tecla. */
  buscarCliente(texto: string): void {
    clearTimeout(this.temporizadorCliente);
    const limpio = texto.trim();
    if (limpio.length < 2) {
      this.resultadosCliente.set([]);
      return;
    }
    this.temporizadorCliente = setTimeout(async () => {
      this.buscandoCliente.set(true);
      try {
        this.resultadosCliente.set(await this.api.clientes(limpio));
      } catch {
        this.resultadosCliente.set([]);
      } finally {
        this.buscandoCliente.set(false);
      }
    }, 250);
  }

  elegirCliente(cliente: { id: number; nombre: string }): void {
    this.cliente.set(cliente);
    this.resultadosCliente.set([]);
    this.error.set(null);
    this.aplicaciones.set([]);
    this.cargarNotas(cliente.id);
  }

  cambiarCliente(): void {
    this.cliente.set(null);
    this.resultadosCliente.set([]);
    this.aplicaciones.set([]);
  }

  async cargarNotas(clienteId: number): Promise<void> {
    this.cargandoNotas.set(true);
    try {
      this.aplicaciones.set(await this.api.notasAbiertas(clienteId));
    } catch (falla) {
      this.error.set(errorLegible(falla).mensaje);
    } finally {
      this.cargandoNotas.set(false);
    }
  }

  /**
   * `poner*` y no `monto`: `monto` es la signal del pago.
   *
   * Se confirma con `change` (al salir del campo) y no con `input`, igual
   * que las cantidades del POS: teclear "0." para escribir "0.5" no debe
   * perderse en la primera tecla.
   */
  ponerDeNota(notaId: number, valor: string): void {
    this.aplicaciones.update((notas) =>
      notas.map((n) => (n.nota_id === notaId ? { ...n, monto: valor } : n)),
    );
  }

  /** La nota se cubre entera, con su subtotal — el monto que se ve. */
  aplicarToda(notaId: number): void {
    this.aplicaciones.update((notas) =>
      notas.map((n) => (n.nota_id === notaId ? { ...n, monto: String(n.subtotal) } : n)),
    );
  }

  abrirEditor(): void {
    this.conEditor.set(true);
    this.cliente.set(null);
    this.resultadosCliente.set([]);
    this.fecha.set(hoyComoTexto());
    this.metodoPago.set('');
    this.monto.set('');
    this.referencia.set('');
    this.requiereFactura.set(false);
    this.aplicaciones.set([]);
    this.error.set(null);
  }

  cerrarEditor(): void {
    this.conEditor.set(false);
    this.error.set(null);
  }

  // ------------------------------------------------------------- el listado
  private temporizadorFiltros: ReturnType<typeof setTimeout> | undefined;

  aBuscar(texto: string): void {
    clearTimeout(this.temporizadorFiltros);
    this.temporizadorFiltros = setTimeout(() => {
      this.buscar.set(texto.trim());
      this.recargar();
    }, 250);
  }

  aMetodo(valor: string): void {
    this.metodo.set(valor as '' | MetodoPago);
    this.recargar();
  }

  aDesde(valor: string): void {
    this.desde.set(valor);
    this.recargar();
  }

  aHasta(valor: string): void {
    this.hasta.set(valor);
    this.recargar();
  }

  async recargar(): Promise<void> {
    this.cargandoLista.set(true);
    this.errorLista.set(null);
    this.offset.set(0);
    try {
      const [filas, total] = await this.paginar(0);
      this.listado.set(filas);
      this.total.set(total);
    } catch (falla) {
      this.listado.set([]);
      this.errorLista.set(errorLegible(falla).mensaje);
    } finally {
      this.cargandoLista.set(false);
    }
  }

  async cargarMas(): Promise<void> {
    if (!this.hayMas() || this.buscandoMas()) return;
    this.buscandoMas.set(true);
    try {
      const [siguientes] = await this.paginar(this.listado().length);
      this.listado.update((ya) => [...ya, ...siguientes]);
      this.offset.set(this.listado().length);
    } catch (falla) {
      this.errorLista.set(errorLegible(falla).mensaje);
    } finally {
      this.buscandoMas.set(false);
    }
  }

  /** Pide una pagina y devuelve sus filas con el total de la consulta. */
  private async paginar(offset: number): Promise<[PagoListado[], number]> {
    const metodoActual = this.metodo();
    const resultado = await this.api.listar({
      buscar: this.buscar() || undefined,
      metodo: metodoActual === '' ? undefined : metodoActual,
      desde: this.desde() || undefined,
      hasta: this.hasta() || undefined,
      limite: this.limite,
      offset,
    });
    return [resultado.datos, resultado.total];
  }

  async ver(pago: PagoListado): Promise<void> {
    this.cargandoDetalle.set(true);
    this.errorLista.set(null);
    try {
      this.detalle.set(await this.api.obtener(pago.id));
    } catch (falla) {
      this.errorLista.set(errorLegible(falla).mensaje);
    } finally {
      this.cargandoDetalle.set(false);
    }
  }

  cerrarDetalle(): void {
    this.detalle.set(null);
  }

  // ------------------------------------------------------------- el guardado
  async guardar(): Promise<void> {
    const cliente = this.cliente();
    if (cliente === null || this.guardando()) return;
    const metodoActual = this.metodoPago();
    const metodo = metodoActual === '' ? null : metodoActual;

    this.guardando.set(true);
    this.error.set(null);
    try {
      const cuerpo = cuerpoDePago(
        cliente.id,
        this.fecha(),
        metodo,
        this.monto(),
        this.requiereFactura(),
        this.referencia(),
        this.aplicaciones(),
      );
      await this.api.crear(cuerpo);
      this.cerrarEditor();
      await this.recargar();
    } catch (falla) {
      this.error.set(this.explicar(falla));
    } finally {
      this.guardando.set(false);
    }
  }

  /**
   * Los errores del servicio, traducidos para quien cobra.
   *
   * `MONTO_MAYOR_A_NOTA` es el que vale la pena tratar: el mensaje del
   * backend no dice de qué nota, y el `detalles` sí. La nota ya está en el
   * editor, así que su folio se pone aquí. El resto llega legible.
   */
  private explicar(falla: unknown): string {
    const legible = errorLegible(falla);
    if (legible.codigo !== 'MONTO_MAYOR_A_NOTA') return legible.mensaje;

    const datos = legible.datos as { nota_id?: number } | null;
    const nota = this.aplicaciones().find((n) => n.nota_id === datos?.nota_id);
    return nota === undefined
      ? legible.mensaje
      : `La nota ${nota.folio} ya no acepta ese monto: comprueba cuánto le falta por cobrar.`;
  }

  // ----------------------------------------------------------------- atajos
  montoComoTexto = montoComoTexto;
  METODOS_PAGO = METODOS_PAGO;
  problemaDeAplicacion = problemaDeAplicacion;
}
