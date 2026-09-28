import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { errorLegible } from '../nucleo/api';
import { Sesion } from '../nucleo/sesion';
import { kilosComoTexto } from '../nucleo/cifras';
import { ProductosApi, cuerpoDeProducto, type Catalogo, type Producto } from './productos-api';

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
  imports: [ReactiveFormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Productos {
  private readonly api = inject(ProductosApi);
  private readonly fb = inject(FormBuilder);
  private readonly sesion = inject(Sesion);

  // ------------------------------------------------------------- el listado
  readonly filas = signal<Producto[]>([]);
  readonly total = signal(0);
  readonly offset = signal(0);
  readonly buscando = signal(false);
  readonly error = signal<string | null>(null);
  readonly buscador = signal('');
  readonly filtroActivo = signal<'todos' | 'activos' | 'inactivos'>('activos');

  readonly categorias = signal<Catalogo[]>([]);
  readonly especies = signal<Catalogo[]>([]);

  readonly hayMas = computed(() => this.filas().length < this.total());

  // -------------------------------------------------------------- el editor
  readonly editando = signal<Producto | null>(null);
  readonly guardando = signal(false);
  readonly errorEditor = signal<string | null>(null);

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

  constructor() {
    void this.cargarCatalogos();
    void this.recargar();
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

  private async recargar(): Promise<void> {
    this.buscando.set(true);
    this.error.set(null);
    try {
      const buscar = this.buscador().trim();
      const resultado = await this.api.listar({
        buscar: buscar.length >= 2 ? buscar : undefined,
        activo: this.filtroActivo(),
      });
      this.filas.set(resultado.datos);
      this.total.set(resultado.total);
      this.offset.set(resultado.offset);
    } catch (falla) {
      this.error.set(errorLegible(falla).mensaje);
    } finally {
      this.buscando.set(false);
    }
  }

  async cargarMas(): Promise<void> {
    if (this.buscando()) return;
    this.buscando.set(true);
    try {
      const buscar = this.buscador().trim();
      const resultado = await this.api.listar({
        buscar: buscar.length >= 2 ? buscar : undefined,
        activo: this.filtroActivo(),
        offset: this.offset() + this.filas().length,
      });
      this.filas.update((actuales) => [...actuales, ...resultado.datos]);
      this.total.set(resultado.total);
    } catch (falla) {
      this.error.set(errorLegible(falla).mensaje);
    } finally {
      this.buscando.set(false);
    }
  }

  // -------------------------------------------------------------- el editor

  nuevo(): void {
    this.forma.reset({
      codigo: '',
      nombre: '',
      presentacion_kg: '',
      categoria_id: '',
      especie_id: '',
    });
    this.errorEditor.set(null);
    this.editando.set({} as Producto);
  }

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
  }

  cancelar(): void {
    this.editando.set(null);
    this.errorEditor.set(null);
  }

  /** Alta o edicion. El `activo` se manda solo en la edicion. */
  async guardar(): Promise<void> {
    if (this.guardando() || this.forma.invalid) return;

    this.guardando.set(true);
    this.errorEditor.set(null);
    const cuerpo = cuerpoDeProducto(this.forma.getRawValue());

    try {
      const actual = this.editando();
      if (actual === null) return;
      if (actual.id === undefined) {
        await this.api.crear(cuerpo);
      } else {
        await this.api.actualizar(actual.id, cuerpo, actual.activo);
      }
      this.editando.set(null);
      await this.recargar();
    } catch (falla) {
      const legible = errorLegible(falla);
      if (legible.codigo === 'CODIGO_DUPLICADO') {
        this.forma.controls.codigo.setErrors({ duplicado: true });
      }
      this.errorEditor.set(legible.mensaje);
    } finally {
      this.guardando.set(false);
    }
  }

  /** Alterna el `activo` desde la fila, sin abrir el editor. */
  async alternaActivo(producto: Producto): Promise<void> {
    if (this.guardando()) return;
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
    } catch (falla) {
      this.error.set(errorLegible(falla).mensaje);
    } finally {
      this.guardando.set(false);
    }
  }

  async eliminar(producto: Producto): Promise<void> {
    if (
      !window.confirm(`Eliminar ${producto.nombre}? Esto falla si el producto tiene historial.`)
    ) {
      return;
    }
    this.error.set(null);
    try {
      await this.api.eliminar(producto.id);
      await this.recargar();
    } catch (falla) {
      this.error.set(errorLegible(falla).mensaje);
    }
  }
}
