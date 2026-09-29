import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { errorLegible } from '../nucleo/api';
import { Sesion } from '../nucleo/sesion';
import { crearBuscador } from '../nucleo/buscador';
import { montoComoTexto } from '../nucleo/cifras';
import {
  cuerpoDePrecio,
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
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Precios {
  private readonly api = inject(PreciosApi);
  private readonly sesion = inject(Sesion);

  readonly puedeEditar = computed(() => this.sesion.puede('precios.editar'));

  // ------------------------------------------------------------- la vista
  readonly vista = signal<'publicos' | 'clientes'>('publicos');

  readonly filas = signal<FilaPrecio[]>([]);
  readonly total = signal(0);
  readonly limite = 50;
  readonly cargando = signal(false);
  readonly buscandoMas = signal(false);
  readonly error = signal<string | null>(null);

  readonly vigencia = signal<Vigencia>('vigentes');
  readonly filtroProducto = signal<OpcionFiltro | null>(null);
  readonly filtroCliente = signal<OpcionFiltro | null>(null);

  readonly hayMas = computed(() => this.filas().length < this.total());
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
    this.recargar();
  }

  elegirFiltroCliente(opcion: OpcionFiltro): void {
    this.filtroCliente.set(opcion);
    this.recargar();
  }

  quitarFiltroProducto(): void {
    this.filtroProducto.set(null);
    this.buscadorFiltroProducto.limpiar();
    this.recargar();
  }

  quitarFiltroCliente(): void {
    this.filtroCliente.set(null);
    this.buscadorFiltroCliente.limpiar();
    this.recargar();
  }

  aVigencia(valor: string): void {
    this.vigencia.set(valor as Vigencia);
    this.recargar();
  }

  cambiarVista(vista: 'publicos' | 'clientes'): void {
    this.vista.set(vista);
    this.cerrarEditor();
    this.recargar();
  }

  // ------------------------------------------------------------- el listado
  async recargar(): Promise<void> {
    this.cargando.set(true);
    this.error.set(null);
    try {
      const [filas, total] = await this.paginar(0);
      this.filas.set(filas);
      this.total.set(total);
    } catch (falla) {
      this.filas.set([]);
      this.error.set(errorLegible(falla).mensaje);
    } finally {
      this.cargando.set(false);
    }
  }

  async cargarMas(): Promise<void> {
    if (!this.hayMas() || this.buscandoMas()) return;
    this.buscandoMas.set(true);
    try {
      const [filas] = await this.paginar(this.filas().length);
      this.filas.update((ya) => [...ya, ...filas]);
    } catch (falla) {
      this.error.set(errorLegible(falla).mensaje);
    } finally {
      this.buscandoMas.set(false);
    }
  }

  /** Pide una página del recurso que esté abierto y la mapea a la fila. */
  private async paginar(offset: number): Promise<[FilaPrecio[], number]> {
    const criterios = {
      producto_id: this.filtroProducto()?.id,
      cliente_id: this.filtroCliente()?.id,
      vigencia: this.vigencia(),
      limite: this.limite,
      offset,
    };
    if (this.vista() === 'publicos') {
      const r = await this.api.listarPublicos(criterios);
      return [r.datos.map((p) => filaDePublico(p)), r.total];
    }
    const r = await this.api.listarClientes(criterios);
    return [r.datos.map((p) => filaDeCliente(p)), r.total];
  }

  // -------------------------------------------------------- el editor
  nuevo(): void {
    this.abrirEditor(null);
  }

  editar(fila: FilaPrecio): void {
    this.abrirEditor(fila);
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
    try {
      const cuerpo = cuerpoDePrecio(this.precioKg(), this.vigenteDesde(), this.vigenteHasta());
      await this.guardarCuerpo(cuerpo);
      this.cerrarEditor();
      await this.recargar();
    } catch (falla) {
      this.errorEditor.set(errorLegible(falla).mensaje);
    } finally {
      this.guardando.set(false);
    }
  }

  // ------------------------------------------------------------ el cierre
  pedirCierre(fila: FilaPrecio): void {
    this.cerrando.set(fila);
    this.hastaCierre.set(hoyComoTexto());
    this.errorEditor.set(null);
  }

  cancelarCierre(): void {
    this.cerrando.set(null);
  }

  async cerrar(): Promise<void> {
    const fila = this.cerrando();
    if (fila === null || this.cerrandoPrecio()) return;
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
      await this.recargar();
    } catch (falla) {
      this.errorEditor.set(errorLegible(falla).mensaje);
    } finally {
      this.cerrandoPrecio.set(false);
    }
  }

  // --------------------------------------------------------------- atajos
  montoComoTexto = montoComoTexto;
  problemaDePrecio = problemaDePrecio;
  problemaDeVigencia = problemaDeVigencia;
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
