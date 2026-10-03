import { ChangeDetectionStrategy, Component, computed, inject, signal, viewChild } from '@angular/core';
import { errorLegible } from '../nucleo/api';
import { Sesion } from '../nucleo/sesion';
import { ToastService } from '../nucleo/toast.service';
import { crearBuscador } from '../nucleo/buscador';
import { montoComoTexto } from '../nucleo/cifras';
import { ConfirmModal } from '../productos/confirm-modal';
import {
  cuerpoDePrecio,
  criteriosDe,
  hoyComoTexto,
  problemaDePrecio,
  problemaDeVigencia,
  PreciosApi,
  type CuerpoPrecio,
  type OpcionFiltro,
  type PrecioPublico,
  type PrecioCliente,
  type Vigencia,
} from './precios-api';

/** La fila de la tabla: el publico y el de cliente, con lo comun a la vista. */
interface FilaPrecio {
  id: number;
  producto_id: number;
  producto_codigo: string;
  producto_nombre: string;
  cliente_id?: number;
  cliente_nombre?: string;
  precio_kg: number;
  vigente_desde: string;
  vigente_hasta: string | null;
}

/**
 * La lista de precios.
 *
 * Dos recursos en una pantalla, no un recurso con un tipo (ver
 * `precios/rutas.ts`): `publicos` es el precio de lista del producto y
 * `clientes` lo pactado con una persona, y mezclarlos en una sola tabla
 * obligaria al operador a entender el trasfondo de la base. La vista tiene
 * dos pestanas, una por recurso, y cada una habla su idioma.
 *
 * Tres decisiones que no son obvias:
 *
 *   - No hay botón de borrar: un precio no se borra, se CIERRA (le pone
 *     fecha de fin), porque las notas de remision guardan el precio que se
 *     leyo al cobrar y sin la fila ya no se reconstruye de donde salio ese
 *     numero. Por eso la accion fuerte de cada fila es "Cerrar", que pide
 *     la fecha y deja el registro.
 *   - Por omision se ven los VIGENTES (`vigencia: 'vigentes'`): un precio
 *     que ya no aplica, al lado del que si, es el error que la pantalla
 *     quiere evitar. El historico de un producto se ve con su filtro.
 *   - El precio se captura como TEXTO y se normaliza al mandar (`cuerpoDePrecio`),
 *     igual que los montos del pago, porque el esquema quiere "8.50" y no
 *     una coma ni ceros de mas.
 */
@Component({
  selector: 'app-precios',
  templateUrl: './precios.html',
  styleUrl: './precios.scss',
  imports: [ConfirmModal],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Precios {
  private readonly api = inject(PreciosApi);
  private readonly sesion = inject(Sesion);
  private readonly toast = inject(ToastService);

  readonly confirmModal = viewChild.required(ConfirmModal);

  readonly puedeEditar = computed(() => this.sesion.puede('precios.editar'));

  // ------------------------------------------------------------- la vista
  readonly vista = signal<'publicos' | 'clientes'>('publicos');

  readonly filas = signal<FilaPrecio[]>([]);
  readonly total = signal(0);

  /**
   * Cuantos precios se ven por pagina, y la pagina que se esta viendo.
   *
   * Antes esto era un "cargar mas" que pegaba las siguientes al final de la
   * tabla. Con 50, 100 o mas precios eso es una tabla de tres pantallas, y
   * para llegar al precio de un producto del mes pasado habia que bajar y
   * bajar. Con paginas la tabla tiene alto fijo: se sabe cuantas hay, se sabe
   * en cual se esta, y se llega en un clic.
   *
   * La pagina se elige en SALTOS y se traduce a `offset` al pedir, porque un
   * numero de pagina guardado seria un `offset` guardado, que se queda viejo
   * en cuanto cambia el filtro.
   */
  readonly limite = signal(50);
  readonly pagina = signal(1);
  readonly cargando = signal(false);
  readonly error = signal<string | null>(null);

  /** Cuantas paginas hay en total, con el tamano de pagina elegido. */
  readonly paginasTotales = computed(() => Math.max(1, Math.ceil(this.total() / this.limite())));

  readonly hayPaginaAnterior = computed(() => this.pagina() > 1);
  readonly hayPaginaSiguiente = computed(() => this.pagina() < this.paginasTotales());

  /** Que se ve en la barra: "1-50 de 340". */
  readonly rangoDePagina = computed(() => {
    const total = this.total();
    if (total === 0) return '0 de 0';
    const desde = (this.pagina() - 1) * this.limite() + 1;
    const hasta = Math.min(this.pagina() * this.limite(), total);
    return `${desde}-${hasta} de ${total}`;
  });

  readonly vigencia = signal<Vigencia>('vigentes');
  readonly filtroProducto = signal<OpcionFiltro | null>(null);
  readonly filtroCliente = signal<OpcionFiltro | null>(null);

/**
 * Si el listado lleva filtros puestos.
 *
 * Distingue "no hay precios" de "el filtro se los ha llevado todos": en el
 * primer caso lo que hace falta es crear uno, y en el segundo quitar el
 * filtro. `total` no sirve para esto porque ya viene filtrado: con un
 * filtro que no coincide da 0 igual que cuando la tabla esta vacia de
 * verdad. `vigentes` es lo que se ve por defecto, asi que no cuenta como
 * filtro.
 */
readonly hayFiltros = computed(
  () =>
    this.vigencia() !== 'vigentes' ||
    this.filtroProducto() !== null ||
    this.filtroCliente() !== null,
);
  readonly esClientes = computed(() => this.vista() === 'clientes');

  /** El listado se pide al entrar: sin esto la tabla sale en vacio. */
  constructor() {
    void this.recargar();
  }

  // ---------------------------------------------------------- el editor
  /** `null` con `editorAbierto` es "nuevo"; con fila es "editar". */
  readonly editando = signal<FilaPrecio | null>(null);
  readonly editorAbierto = signal(false);

  readonly producto = signal<OpcionFiltro | null>(null);
  readonly cliente = signal<OpcionFiltro | null>(null);

  /**
   * Los buscadores del editor.
   *
   * El producto se busca desde una letra porque su codigo son tres (`LAC`) y
   * en un mostrador se teclea el codigo, no el nombre; el cliente pide dos
   * porque con una sola letra el listado devuelve cientos y no dice nada.
   */
  readonly buscadorProducto = crearBuscador({
    cargar: (texto) => this.api.productos(texto),
    minimo: 1,
    nada: (texto) => `Ningún producto coincide con «${texto}».`,
    alElegir: (opcion) => this.elegirProductoEditor(opcion),
  });

  readonly buscadorCliente = crearBuscador({
    cargar: (texto) => this.api.clientes(texto),
    minimo: 2,
    nada: (texto) => `Ningún cliente coincide con «${texto}».`,
    alElegir: (opcion) => this.elegirClienteEditor(opcion),
  });

  readonly precioKg = signal('');
  readonly vigenteDesde = signal(hoyComoTexto());
  readonly vigenteHasta = signal('');

  readonly guardando = signal(false);
  readonly errorEditor = signal<string | null>(null);

  // --------------------------------------------- el cierre (no hay borrar)
  /** La fila a la que se le pide fecha de cierre. */
  readonly cerrando = signal<FilaPrecio | null>(null);
  readonly hastaCierre = signal(hoyComoTexto());
  readonly cerrandoPrecio = signal(false);

  /**
   * Por que no se puede cerrar todavia, o null si la fecha sirve.
   *
   * El backend rechaza estas tres cosas (`servicio.ts`), pero solo DESPUES de
   * haber enviado la peticion, y con un 400 que llega cuando el usuario ya
   * esta esperando: "no se puede cerrar un precio con una fecha que ya
   * paso", "la vigencia no puede terminar antes de empezar". Se comprueba
   * aqui para que el boton se apague y el motivo se lea junto al campo.
   *
   * La fecha de cierre no puede estar en el pasado porque `hoy()` es el
   * corte del servidor: un cierre con fecha de ayer dejaria el precio
   * vigente hoy, que es justo lo contrario de cerrarlo.
   */
  readonly problemaCierre = computed(() => {
    const fila = this.cerrando();
    if (fila === null) return null;

    const hasta = this.hastaCierre().trim();
    if (hasta === '') return 'Elige hasta cuando aplica este precio.';
    if (problemaDeVigencia(fila.vigente_desde, hasta) !== null) {
      return `No puede cerrarse antes de que empiece (${fila.vigente_desde}).`;
    }
    if (hasta < hoyComoTexto()) return 'No se puede cerrar con una fecha que ya pasó.';
    return null;
  });

  readonly puedeCerrar = computed(() => !this.cerrandoPrecio() && this.problemaCierre() === null);

  readonly puedeGuardar = computed(() => {
    if (!this.puedeEditar() || this.guardando()) return false;
    const editando = this.editando();
    const productoId = this.producto()?.id ?? editando?.producto_id;
    if (productoId === undefined) return false;
    if (this.esClientes()) {
      const clienteId = this.cliente()?.id ?? editando?.cliente_id;
      if (clienteId === undefined) return false;
    }
    if (problemaDePrecio(this.precioKg()) !== null) return false;
    return problemaDeVigencia(this.vigenteDesde(), this.vigenteHasta()) === null;
  });

  // ------------------------------------------------------------- filtros
  /** Los buscadores del listado: eligen un producto o cliente a filtrar. */
  readonly buscadorFiltroProducto = crearBuscador({
    cargar: (texto) => this.api.productos(texto),
    minimo: 1,
    nada: (texto) => `Ningún producto coincide con «${texto}».`,
    alElegir: (opcion) => this.elegirFiltroProducto(opcion),
  });

  readonly buscadorFiltroCliente = crearBuscador({
    cargar: (texto) => this.api.clientes(texto),
    minimo: 2,
    nada: (texto) => `Ningún cliente coincide con «${texto}».`,
    alElegir: (opcion) => this.elegirFiltroCliente(opcion),
  });

  elegirFiltroProducto(opcion: OpcionFiltro): void {
    this.filtroProducto.set(opcion);
    void this.recargar();
  }

  elegirFiltroCliente(opcion: OpcionFiltro): void {
    this.filtroCliente.set(opcion);
    void this.recargar();
  }

  quitarFiltroProducto(): void {
    this.filtroProducto.set(null);
    this.buscadorFiltroProducto.limpiar();
    void this.recargar();
  }

  quitarFiltroCliente(): void {
    this.filtroCliente.set(null);
    this.buscadorFiltroCliente.limpiar();
    void this.recargar();
  }

  /**
   * Quita todos los filtros de golpe.
   *
   * Sin esto hay que quitar la vigencia y cada busqueda por separado, y el
   * filtro de cliente solo se quita si se esta en su pestana: puesto en la
   * de precios de lista no hay ni chip que pulsarlo.
   */
  quitarFiltros(): void {
    this.vigencia.set('vigentes');
    this.filtroProducto.set(null);
    this.filtroCliente.set(null);
    this.buscadorFiltroProducto.limpiar();
    this.buscadorFiltroCliente.limpiar();
    void this.recargar();
  }

  aVigencia(valor: string): void {
    this.vigencia.set(valor as Vigencia);
    void this.recargar();
  }

  /**
   * Cambia de pestana.
   *
   * El filtro de cliente se quita al salir de su pestana porque el listado de
   * precios de lista no lo acepta: lo rechaza con un 400. Antes se quedaba
   * puesto a oscuras y la pantalla se caia al volver.
   */
  cambiarVista(vista: 'publicos' | 'clientes'): void {
    this.vista.set(vista);
    this.cerrarEditor();
    if (vista === 'publicos') {
      this.filtroCliente.set(null);
      this.buscadorFiltroCliente.limpiar();
    }
    void this.recargar();
  }

  // ------------------------------------------------------------- el listado
  /**
   * Carga una pagina del listado.
   *
   * Es la UNICA forma de pedir precios. Antes habia dos (`recargar` y
   * `cargarMas`) que pegaba filas al final de la tabla; con paginacion hay
   * una sola, y `recargar()` es esta con la pagina 1.
   *
   * `total` se pone a 0 tambien cuando la llamada falla: si no, el contador
   * de abajo se queda diciendo "0 de 340 precios" sobre una tabla vacia que
   * fallo por red, que es peor que no decir nada.
   */
  private async cargarPagina(pagina: number): Promise<void> {
    this.cargando.set(true);
    this.error.set(null);
    try {
      const [filas, total] = await this.pedir(pagina);
      this.filas.set(filas);
      this.total.set(total);
      this.pagina.set(pagina);
    } catch (falla) {
      this.filas.set([]);
      this.total.set(0);
      this.error.set(errorLegible(falla).mensaje);
    } finally {
      this.cargando.set(false);
    }
  }

  /** Vuelve a la primera pagina, con el filtro que se tenga puesto. */
  async recargar(): Promise<void> {
    await this.cargarPagina(1);
  }

  /**
   * Cambia de pagina y sube la tabla a la vista.
   *
   * El scroll se queda donde estaba, y como la tabla esta mas abajo el
   * cambio de pagina no se ve: solo se mueve el numero de la barra, que puede
   * estar fuera de pantalla.
   */
  async irAPagina(pagina: number): Promise<void> {
    if (pagina < 1 || pagina > this.paginasTotales() || pagina === this.pagina()) return;
    await this.cargarPagina(pagina);
    this.subirTabla();
  }

  /**
   * El tamano de pagina como texto, para el `[value]` del desplegable.
   *
   * En las plantillas de Angular no hay `String` global (si `JSON`, si
   * `Math`, pero no `String`), y `[value]` necesita texto: con un numero, el
   * `value` del `select` no coincide con ninguna opcion y sale vacio.
   */
  limiteComoTexto(): string {
    return String(this.limite());
  }

  /**
   * Cambia cuantos precios se ven por pagina.
   *
   * Vuelve SIEMPRE a la pagina 1: quedarse en la 7 y pasar de 50 a 100 filas
   * es quedarse en un `offset` que ya no quiere decir nada.
   */
  async aTamanoDePagina(valor: string): Promise<void> {
    this.limite.set(Number(valor));
    await this.cargarPagina(1);
  }

  private subirTabla(): void {
    document.querySelector('.tabla-precios')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /**
   * Pide una pagina del recurso que este abierto y la mapea a la fila.
   *
   * Los criteria se arman con `criteriosDe`, que es quien sabe que key acepta
   * cada listado: el de precios de lista rechaza `cliente_id` con un 400.
   */
  private async pedir(pagina: number): Promise<[FilaPrecio[], number]> {
    const criterios = criteriosDe(this.vista(), {
      productoId: this.filtroProducto()?.id,
      clienteId: this.filtroCliente()?.id,
      vigencia: this.vigencia(),
      limite: this.limite(),
      pagina,
    });

    if (this.vista() === 'publicos') {
      const r = await this.api.listarPublicos(criterios);
      return [r.datos.map((p) => filaDePublico(p)), r.total];
    }

    const r = await this.api.listarClientes(criterios);
    return [r.datos.map((p) => filaDeCliente(p)), r.total];
  }

  // -------------------------------------------------------- el editor
  /** Alta limpia. La abre el boton de la cabecera (ver `alternarEditor`). */
  private nuevo(): void {
    this.abrirEditor(null);
  }

  editar(fila: FilaPrecio): void {
    this.abrirEditor(fila);
  }

  /**
   * El boton de la cabecera.
   *
   * Desplegar siempre abre un alta, no el precio a medias con el que se
   * quedo la vez anterior: si el usuario cierra el editor a medias y vuelve
   * a pulsar, lo espera es el formulario limpio.
   */
  alternarEditor(): void {
    if (this.editorAbierto()) {
      this.cerrarEditor();
      return;
    }
    this.nuevo();
  }

  private abrirEditor(fila: FilaPrecio | null): void {
    this.editando.set(fila);
    this.editorAbierto.set(true);
    this.producto.set(null);
    this.cliente.set(null);
    this.precioKg.set(fila === null ? '' : String(fila.precio_kg));
    this.vigenteDesde.set(fila === null ? hoyComoTexto() : fila.vigente_desde);
    this.vigenteHasta.set(fila?.vigente_hasta ?? '');
    this.buscadorProducto.limpiar();
    this.buscadorCliente.limpiar();
    this.cancelarCierre();
    this.errorEditor.set(null);
  }

  cerrarEditor(): void {
    this.editorAbierto.set(false);
    this.editando.set(null);
    this.cancelarCierre();
    this.errorEditor.set(null);
  }

  elegirProductoEditor(opcion: OpcionFiltro): void {
    this.producto.set(opcion);
    this.errorEditor.set(null);
  }

  elegirClienteEditor(opcion: OpcionFiltro): void {
    this.cliente.set(opcion);
    this.errorEditor.set(null);
  }

  quitarProductoEditor(): void {
    this.producto.set(null);
    this.buscadorProducto.limpiar();
  }

  quitarClienteEditor(): void {
    this.cliente.set(null);
    this.buscadorCliente.limpiar();
  }

  private async guardarCuerpo(cuerpo: CuerpoPrecio): Promise<void> {
    const editando = this.editando();
    const esClientes = this.esClientes();
    if (editando === null) {
      const productoId = this.producto()?.id;
      if (productoId === undefined) return;
      if (esClientes) {
        const clienteId = this.cliente()?.id;
        if (clienteId === undefined) return;
        await this.api.crearCliente(cuerpo, clienteId, productoId);
      } else {
        await this.api.crearPublico(cuerpo, productoId);
      }
      return;
    }
    if (esClientes) {
      await this.api.actualizarCliente(editando.id, cuerpo);
    } else {
      await this.api.actualizarPublico(editando.id, cuerpo);
    }
  }

  async guardar(): Promise<void> {
    if (!this.puedeGuardar()) return;
    this.guardando.set(true);
    this.errorEditor.set(null);
    const esAlta = this.editando() === null;
    try {
      const cuerpo = cuerpoDePrecio(this.precioKg(), this.vigenteDesde(), this.vigenteHasta());
      await this.guardarCuerpo(cuerpo);
      this.cerrarEditor();
      this.toast.exito(`Precio ${esAlta ? 'creado' : 'guardado'} con éxito`);
      await this.recargar();
    } catch (falla) {
      const legible = errorLegible(falla);
      this.errorEditor.set(legible.mensaje);
      this.toast.error(legible.mensaje);
    } finally {
      this.guardando.set(false);
    }
  }

  // ------------------------------------------------------------ el cierre
  /**
   * Pedir el cierre de un precio.
   *
   * Cierra el editor antes: son dos formularios sobre la misma pantalla y no
   * pueden quedar los dos abiertos a la vez, porque el segundo tapa al
   * primero y se guardaria el equivocado.
   */
  pedirCierre(fila: FilaPrecio): void {
    this.editorAbierto.set(false);
    this.editando.set(null);
    this.cerrando.set(fila);
    this.hastaCierre.set(hoyComoTexto());
    this.errorEditor.set(null);
  }

  cancelarCierre(): void {
    this.cerrando.set(null);
  }

  async cerrar(): Promise<void> {
    const fila = this.cerrando();
    if (fila === null || !this.puedeCerrar()) return;
    this.cerrandoPrecio.set(true);
    this.errorEditor.set(null);
    try {
      const hasta = this.hastaCierre();
      if (this.vista() === 'publicos') {
        await this.api.cerrarPublico(fila.id, hasta);
      } else {
        await this.api.cerrarCliente(fila.id, hasta);
      }
      this.cerrando.set(null);
      this.toast.exito(`Precio de "${fila.producto_nombre}" cerrado con éxito`);
      await this.recargar();
    } catch (falla) {
      const legible = errorLegible(falla);
      this.errorEditor.set(legible.mensaje);
      this.toast.error(legible.mensaje);
    } finally {
      this.cerrandoPrecio.set(false);
    }
  }

  /**
   * Vuelve a aplicar un precio cerrado, quitándole la fecha de fin.
   *
   * Sin esto un precio cerrado por error se queda asi para siempre: no hay
   * boton de borrar, y el unico camino era el editor, donde "cerrado por fin
   * de vigencia" se vacia a mano. Aqui la fecha se manda en `null`, que en el
   * PATCH significa "abrir de nuevo" y no "no lo mandes" (`precios-api.ts`).
   *
   * Si al reabrirlo choca con otro precio que ocupa esas fechas, el backend
   * responde 409 `VIGENCIA_TRASLAPADA` y el mensaje dice que se cierre el
   * anterior: es lo correcto, no se puede aplicar dos precios a la vez.
   */
  async reabrir(fila: FilaPrecio): Promise<void> {
    if (this.cerrandoPrecio()) return;

    const confirmado = await this.confirmModal().abrir({
      titulo: 'Reabrir precio',
      mensaje: `¿Volver a aplicar el precio de "${fila.producto_nombre}"? Se le quita la fecha de fin.`,
      textoConfirmar: 'Reabrir',
      variante: 'normal',
    });
    if (!confirmado) return;

    this.cerrandoPrecio.set(true);
    this.error.set(null);
    try {
      // El precio y el inicio se mandan tal cual: reabrir es quitarle solo
      // la fecha de fin, no cambiar el monto ni cuando empezo a valer.
      const cuerpo = cuerpoDePrecio(montoComoTexto(fila.precio_kg), fila.vigente_desde, '');
      if (this.vista() === 'publicos') {
        await this.api.actualizarPublico(fila.id, cuerpo);
      } else {
        await this.api.actualizarCliente(fila.id, cuerpo);
      }
      this.toast.exito(`Precio de "${fila.producto_nombre}" reabierto`);
      await this.recargar();
    } catch (falla) {
      const legible = errorLegible(falla);
      this.error.set(legible.mensaje);
      this.toast.error(legible.mensaje);
    } finally {
      this.cerrandoPrecio.set(false);
    }
  }

  /** Enter guarda el editor, Escape lo cierra. Como en productos. */
  onKeydown(evento: KeyboardEvent): void {
    if (evento.key === 'Escape' && this.editorAbierto()) {
      evento.preventDefault();
      this.cerrarEditor();
      return;
    }
    if (evento.key === 'Enter' && this.editorAbierto() && this.puedeGuardar()) {
      evento.preventDefault();
      void this.guardar();
    }
  }

  // --------------------------------------------------------------- atajos
  montoComoTexto = montoComoTexto;
  problemaDePrecio = problemaDePrecio;
  problemaDeVigencia = problemaDeVigencia;
  /** "Hoy", para el atajo de cerrar y para el valor por defecto. */
  hoy = hoyComoTexto;
}

function filaDePublico(p: PrecioPublico): FilaPrecio {
  return {
    id: p.id,
    producto_id: p.producto_id,
    producto_codigo: p.producto_codigo,
    producto_nombre: p.producto_nombre,
    precio_kg: p.precio_kg,
    vigente_desde: p.vigente_desde,
    vigente_hasta: p.vigente_hasta,
  };
}

function filaDeCliente(p: PrecioCliente): FilaPrecio {
  return {
    id: p.id,
    producto_id: p.producto_id,
    cliente_id: p.cliente_id,
    cliente_nombre: p.cliente_nombre,
    producto_codigo: p.producto_codigo,
    producto_nombre: p.producto_nombre,
    precio_kg: p.precio_kg,
    vigente_desde: p.vigente_desde,
    vigente_hasta: p.vigente_hasta,
  };
}
