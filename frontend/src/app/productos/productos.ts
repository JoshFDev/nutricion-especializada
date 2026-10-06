import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, viewChild } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { filasAnimation, Recarga } from '../nucleo/animaciones';
import { errorLegible } from '../nucleo/api';
import { Sesion } from '../nucleo/sesion';
import { kilosComoTexto } from '../nucleo/cifras';
import { ProductosApi, cuerpoDeProducto, type Catalogo, type Producto } from './productos-api';
import { ConfirmModal } from './confirm-modal';
import { ToastService } from '../nucleo/toast.service';

/**
 * La pantalla de productos.
 *
 * Misma estructura que la de clientes: listado con busqueda y filtro de
 * estado, mas un editor para alta/edicion. Aqui `editar()` si valida el
 * `activo` del producto, porque el estado vive en la fila y el backend lo
 * acepta en el PATCH (no en el alta).
 *
 * Dos filtros que conviene no confundir: el del LISTADO (`activo` suelto en
 * `productos/esquemas.ts`) y el del EDITOR (`activo` dentro del PATCH). El
 * primero decide que filas se ven; el segundo, si el producto se ofrece a la
 * venta.
 */

@Component({
  selector: 'app-productos',
  templateUrl: './productos.html',
  styleUrl: './productos.scss',
  imports: [ReactiveFormsModule, ConfirmModal],
  changeDetection: ChangeDetectionStrategy.OnPush,
  animations: [filasAnimation],
})
export class Productos {
  private readonly api = inject(ProductosApi);
  private readonly fb = inject(FormBuilder);
  private readonly sesion = inject(Sesion);
  private readonly toast = inject(ToastService);

  // ------------------------------------------------------------- el listado
  /** Para la cascada de entrada de la tabla. Ver `nucleo/animaciones.ts`. */
  readonly recarga = new Recarga();

  readonly filas = signal<Producto[]>([]);
  readonly total = signal(0);
  readonly buscando = signal(false);
  readonly error = signal<string | null>(null);
  readonly buscador = signal('');
  readonly filtroActivo = signal<'todos' | 'activos' | 'inactivos'>('activos');
  readonly filtroCategoria = signal<number | null>(null);
  readonly filtroEspecie = signal<number | null>(null);
  readonly exportando = signal(false);

  readonly categorias = signal<Catalogo[]>([]);
  readonly especies = signal<Catalogo[]>([]);

  /**
   * Cuantos productos se ven por pagina, y la pagina que se esta viendo.
   *
   * Antes esto era un "Cargar más" que pegaba las siguientes al final. Con
   * 50 o mas productos eso es una tabla de tres pantallas, y no hay forma
   * de volver arriba ni de saber en cuanto se esta. Con paginas la tabla
   * tiene alto fijo y el mismo control que precios y el catalogo.
   *
   * La pagina se elige en SALTOS y se traduce a `offset` al pedir, porque
   * un `offset` guardado se queda viejo en cuanto cambia un filtro.
   */
  readonly limite = signal(50);
  readonly pagina = signal(1);

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

  // -------------------------------------------------------------- el editor
  readonly editando = signal<Producto | null>(null);
  readonly guardando = signal(false);
  readonly errorEditor = signal<string | null>(null);
  readonly editorVisible = signal(false);
  readonly hayCambiosSinGuardar = signal(false);

  readonly editorAbierto = computed(() => this.editando() !== null);
  readonly esAlta = computed(() => this.editando()?.id === undefined);

  readonly puedeEditar = computed(() => this.sesion.puede('productos.editar'));

  /** El formulario del editor. El `activo` va del lado de la fila. */
  readonly forma = this.fb.nonNullable.group({
    codigo: ['', Validators.required],
    nombre: ['', Validators.required],
    presentacion_kg: ['', [Validators.required, Validators.pattern(/^\d{1,7}(\.\d{1,3})?$/)]],
    categoria_id: [''],
    especie_id: [''],
  });

  kilosComoTexto = kilosComoTexto;

  readonly confirmModal = viewChild.required(ConfirmModal);
  private codigoInicial = '';

  constructor() {
    void this.cargarCatalogos();
    void this.recargar();

    // Detectar cambios en el formulario para advertir al salir
    effect(() => {
      if (this.editorVisible() && this.editando()) {
        this.forma.valueChanges.subscribe(() => {
          this.hayCambiosSinGuardar.set(this.forma.dirty);
        });
      } else {
        this.hayCambiosSinGuardar.set(false);
      }
    });
  }

  toggleEditor(): void {
    const abrir = !this.editorVisible();
    if (abrir && this.hayCambiosSinGuardar()) {
      // Si hay cambios sin guardar, no cerrar directamente
      return;
    }
    this.editorVisible.set(abrir);
    if (abrir) {
      this.nuevo();
    } else {
      this.cancelar();
    }
  }

  nuevo(): void {
    this.forma.reset({
      codigo: '',
      nombre: '',
      presentacion_kg: '',
      categoria_id: '',
      especie_id: '',
    });
    this.errorEditor.set(null);
    this.hayCambiosSinGuardar.set(false);
    this.editando.set({} as Producto);
    this.editorVisible.set(true);
    // Focus al primer campo después de que el DOM se actualice
    setTimeout(() => {
      const input = document.getElementById('codigo') as HTMLInputElement;
      input?.focus();
    }, 0);
  }

  /** Categoria y especie se cargan una sola vez: el catalogo no cambia entre ediciones. */
  private async cargarCatalogos(): Promise<void> {
    try {
      this.categorias.set(await this.api.categorias());
    } catch {
      this.categorias.set([]);
    }
    try {
      this.especies.set(await this.api.especies());
    } catch {
      this.especies.set([]);
    }
  }

  // ------------------------------------------------------------- el listado

  private temporizador: ReturnType<typeof setTimeout> | undefined;

  /** Busca con 250 ms de espera, igual que el POS. */
  buscar(texto: string): void {
    clearTimeout(this.temporizador);
    this.buscador.set(texto);
    this.temporizador = setTimeout(() => void this.recargar(), 250);
  }

  filtrar(activo: string): void {
    this.filtroActivo.set(activo as 'todos' | 'activos' | 'inactivos');
    void this.recargar();
  }

  filtrarCategoria(categoriaId: string): void {
    this.filtroCategoria.set(categoriaId === '' ? null : Number(categoriaId));
    void this.recargar();
  }

  filtrarEspecie(especieId: string): void {
    this.filtroEspecie.set(especieId === '' ? null : Number(especieId));
    void this.recargar();
  }

  limpiarFiltros(): void {
    this.filtroCategoria.set(null);
    this.filtroEspecie.set(null);
    this.filtroActivo.set('activos');
    this.buscador.set('');
    void this.recargar();
  }

  hayFiltrosActivos(): boolean {
    return this.filtroActivo() !== 'activos' || this.filtroCategoria() !== null || this.filtroEspecie() !== null || this.buscador().trim().length >= 2;
  }

  /**
   * Vuelve a la primera pagina con el filtro que se tenga puesto.
   *
   * Todo cambio de filtro pasa por aqui y no por la pagina: quedarse en la
   * 4 y cambiar de categoría es quedarse en un `offset` que ya no quiere
   * decir nada, y sale una tabla vacia sin que se entienda por que.
   */
  async recargar(): Promise<void> {
    await this.cargarPagina(1);
  }

  /** Carga una pagina. Es la UNICA forma de pedir productos. */
  private async cargarPagina(pagina: number): Promise<void> {
    this.buscando.set(true);
    this.error.set(null);
    try {
      const buscar = this.buscador().trim();
      const resultado = await this.api.listar({
        buscar: buscar.length >= 2 ? buscar : undefined,
        activo: this.filtroActivo(),
        categoria_id: this.filtroCategoria() ?? undefined,
        especie_id: this.filtroEspecie() ?? undefined,
        limite: this.limite(),
        offset: (pagina - 1) * this.limite(),
      });
      this.filas.set(resultado.datos);
      this.recarga.marcar();
      this.total.set(resultado.total);
      this.pagina.set(pagina);
    } catch (falla) {
      this.filas.set([]);
      this.total.set(0);
      this.error.set(errorLegible(falla).mensaje);
    } finally {
      this.buscando.set(false);
    }
  }

  /**
   * Cambia de pagina y sube la tabla a la vista.
   *
   * El scroll se queda donde estaba, y como la tabla esta mas abajo el
   * cambio de pagina no se ve: solo se mueve el numero de la barra, que
   * puede estar fuera de pantalla.
   */
  async irAPagina(pagina: number): Promise<void> {
    if (pagina < 1 || pagina > this.paginasTotales() || pagina === this.pagina()) return;
    await this.cargarPagina(pagina);
    document.querySelector('.tabla-wrapper')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
   * Cambia cuantos productos se ven por pagina.
   *
   * Vuelve SIEMPRE a la pagina 1: quedarse en la 7 y pasar de 50 a 100
   * filas es quedarse en un `offset` que ya no quiere decir nada.
   */
  async aTamanoDePagina(valor: string): Promise<void> {
    this.limite.set(Number(valor));
    await this.cargarPagina(1);
  }

  async exportarExcel(): Promise<void> {
    if (this.exportando()) return;
    this.exportando.set(true);
    try {
      await this.api.exportarExcel({
        buscar: this.buscador().trim().length >= 2 ? this.buscador().trim() : undefined,
        activo: this.filtroActivo(),
        categoria_id: this.filtroCategoria() ?? undefined,
        especie_id: this.filtroEspecie() ?? undefined,
      });
    } catch (falla) {
      this.error.set(errorLegible(falla).mensaje);
    } finally {
      this.exportando.set(false);
    }
  }

  // -------------------------------------------------------------- el editor

  editar(producto: Producto): void {
    this.forma.setValue({
      codigo: producto.codigo,
      nombre: producto.nombre,
      presentacion_kg: String(producto.presentacion_kg),
      categoria_id: producto.categoria_id === null ? '' : String(producto.categoria_id),
      especie_id: producto.especie_id === null ? '' : String(producto.especie_id),
    });
    this.errorEditor.set(null);
    this.editando.set(producto);
    this.editorVisible.set(true);
  }

  cancelar(): void {
    if (this.hayCambiosSinGuardar()) {
      // Se podría agregar confirmación aquí si se desea
      this.hayCambiosSinGuardar.set(false);
    }
    this.editando.set(null);
    this.errorEditor.set(null);
    this.editorVisible.set(false);
  }

  /** Alta o edicion. El `activo` se manda solo en la edicion. */
  async guardar(): Promise<void> {
    if (this.guardando()) return;

    this.forma.markAllAsTouched();
    if (this.forma.invalid) return;

    this.guardando.set(true);
    this.errorEditor.set(null);
    const cuerpo = cuerpoDeProducto(this.forma.getRawValue());

    try {
      const actual = this.editando();
      if (actual === null) return;
      if (actual.id === undefined) {
        await this.api.crear(cuerpo);
        this.toast.exito('Producto creado con éxito');
      } else {
        await this.api.actualizar(actual.id, cuerpo, actual.activo);
        this.toast.exito('Producto guardado con éxito');
      }
      await this.recargar();
      this.hayCambiosSinGuardar.set(false);
      this.cancelar();
    } catch (falla) {
      console.error('[guardar] ERROR:', falla);
      const legible = errorLegible(falla);
      if (legible.codigo === 'CODIGO_DUPLICADO') {
        this.forma.controls.codigo.setErrors({ duplicado: true });
      }
      this.errorEditor.set(legible.mensaje);
    } finally {
      this.guardando.set(false);
    }
  }

  /** Maneja atajos de teclado en el editor */
  onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      this.guardar();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      this.cancelar();
    }
  }

  /** Alterna el `activo` desde la fila, sin abrir el editor. */
  async alternaActivo(producto: Producto): Promise<void> {
    if (this.guardando()) return;

    const accion = producto.activo ? 'dar de baja' : 'activar';
    const confirmado = await this.confirmModal().abrir({
      titulo: accion.charAt(0).toUpperCase() + accion.slice(1) + ' producto',
      mensaje: `¿${accion.charAt(0).toUpperCase() + accion.slice(1)} "${producto.nombre}"?`,
      textoConfirmar: accion.charAt(0).toUpperCase() + accion.slice(1),
      variante: producto.activo ? 'advertencia' : 'normal',
    });

    if (!confirmado) return;

    this.guardando.set(true);
    this.error.set(null);
    try {
      // PATCH con solo `activo`: el servicio lo componen con el resto de la
      // fila o no, pero aqui no interesa tocar mas campos.
      const cuerpo = cuerpoDeProducto({
        codigo: producto.codigo,
        nombre: producto.nombre,
        presentacion_kg: String(producto.presentacion_kg),
        categoria_id: producto.categoria_id === null ? '' : String(producto.categoria_id),
        especie_id: producto.especie_id === null ? '' : String(producto.especie_id),
      });
      await this.api.actualizar(producto.id, cuerpo, !producto.activo);
      await this.recargar();
      this.toast.exito(`Producto ${producto.activo ? 'dado de baja' : 'activado'} con éxito`);
    } catch (falla) {
      this.error.set(errorLegible(falla).mensaje);
    } finally {
      this.guardando.set(false);
    }
  }

  async eliminar(producto: Producto): Promise<void> {
    const confirmado = await this.confirmModal().abrir({
      titulo: 'Eliminar producto',
      mensaje: `¿Eliminar "${producto.nombre}"? Esta acción es irreversible.\n\nSi el producto tiene compras, ventas o movimientos asociados, no se podrá eliminar. En ese caso, se recomienda darlo de baja para dejar de venderlo sin perder el historial.`,
      textoConfirmar: 'Eliminar',
      variante: 'peligro',
    });

    if (!confirmado) return;

    this.error.set(null);
    try {
      await this.api.eliminar(producto.id);
      await this.recargar();
      this.toast.exito('Producto eliminado con éxito');
    } catch (falla) {
      const legible = errorLegible(falla);
      if (legible.codigo === 'EN_USO') {
        this.toast.advertencia(legible.mensaje);
      } else {
        this.error.set(legible.mensaje);
      }
    }
  }
}
