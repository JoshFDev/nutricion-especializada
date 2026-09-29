import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { errorLegible } from '../nucleo/api';
import { Sesion } from '../nucleo/sesion';
import { montoComoTexto } from '../nucleo/cifras';
import { ProveedoresApi, cuerpoDeProveedor, type ProveedorListado } from './proveedores-api';

/**
 * La pantalla de proveedores.
 *
 * Es la mas pequeña del proyecto y por eso no tiene nada que inventar: son
 * nombre, contacto y telefono, y las reglas son las del backend
 * (`proveedores/esquemas.ts`). Lo que si conviene tener presente al tocarla:
 *
 *   - **No hay borrar.** Un proveedor con compras no se elimina, se da de
 *     baja, y la baja es `activo: false` por PATCH. El unico boton de la
 *     fila que cambia el estado es "Dar de baja"/"Activar", y manda un PATCH
 *     de un solo campo (ver `ProveedoresApi.alternarActivo`): dar de baja a
 *     alguien no debe poder reescribirle el telefono.
 *   - **El nombre es la llave.** Es UNIQUE en la base, el servicio responde
 *     `PROVEEDOR_DUPLICADO` y eso se pega al campo, como el codigo en
 *     clientes. En una compra el proveedor se elige por nombre, y dos
 *     proveedores con el mismo nombre no se distinguen.
 *   - **El alta y la edicion piden el MISMO permiso** (`proveedores.editar`),
 *     porque es el unico que existe en la tabla de permisos. Por eso no hay
 *     `puedeCrear` y `puedeEditar` como en clientes: aqui alcanza con
 *     `proveedores.editar`.
 *   - **El saldo no se edita.** Se lee (lo recalcula la base con las compras
 *     y los pagos) y por eso la columna es de solo lectura: un proveedor
 *     "cuadrado a mano" es un saldo que la siguiente compra vuelve a mover.
 */

@Component({
  selector: 'app-proveedores',
  templateUrl: './proveedores.html',
  styleUrl: './proveedores.scss',
  imports: [ReactiveFormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Proveedores {
  private readonly api = inject(ProveedoresApi);
  private readonly fb = inject(FormBuilder);
  private readonly sesion = inject(Sesion);

  // ------------------------------------------------------------- el listado
  readonly filas = signal<ProveedorListado[]>([]);
  readonly total = signal(0);
  readonly offset = signal(0);
  readonly buscando = signal(false);
  readonly error = signal<string | null>(null);
  readonly buscador = signal('');
  readonly filtroActivo = signal<'todos' | 'activos' | 'inactivos'>('activos');

  readonly hayMas = computed(() => this.filas().length < this.total());

  // -------------------------------------------------------------- el editor
  readonly editando = signal<ProveedorListado | null>(null);
  readonly guardando = signal(false);
  readonly errorEditor = signal<string | null>(null);

  readonly editorAbierto = computed(() => this.editando() !== null);
  readonly esAlta = computed(() => this.editando()?.id === undefined);

  readonly puedeEditar = computed(() => this.sesion.puede('proveedores.editar'));

  /** El formulario del editor. El `activo` NO va aqui: lo pone la base. */
  readonly forma = this.fb.nonNullable.group({
    nombre: ['', [Validators.required, Validators.maxLength(120)]],
    contacto: ['', [Validators.maxLength(120)]],
    telefono: ['', [Validators.maxLength(40)]],
  });

  montoComoTexto = montoComoTexto;

  constructor() {
    void this.recargar();
  }

  // ------------------------------------------------------------- el listado

  private temporizador: ReturnType<typeof setTimeout> | undefined;

  /** Busca con 250 ms de espera, igual que el resto de las pantallas. */
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
      const resultado = await this.api.listar({
        buscar: this.textoBusqueda(),
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
      const resultado = await this.api.listar({
        buscar: this.textoBusqueda(),
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

  /**
   * El texto de busqueda, o `undefined` si es muy corto.
   *
   * El minimo de DOS caracteres es el mismo de las otras pantallas: con uno
   * solo el `ILIKE '%a%'` del backend (`proveedores/repositorio.ts`) trae
   * medio catalogo y la tabla deja de informar.
   */
  private textoBusqueda(): string | undefined {
    const limpio = this.buscador().trim();
    return limpio.length >= 2 ? limpio : undefined;
  }

  // -------------------------------------------------------------- el editor

  nuevo(): void {
    this.forma.reset({ nombre: '', contacto: '', telefono: '' });
    this.errorEditor.set(null);
    // Sin id: el editor sabe que es alta (ver `esAlta`).
    this.editando.set({} as ProveedorListado);
  }

  editar(proveedor: ProveedorListado): void {
    this.forma.setValue({
      nombre: proveedor.nombre,
      contacto: proveedor.contacto ?? '',
      telefono: proveedor.telefono ?? '',
    });
    this.errorEditor.set(null);
    this.editando.set(proveedor);
  }

  cancelar(): void {
    this.editando.set(null);
    this.errorEditor.set(null);
  }

  /** El mensaje de un campo, si el backend lo mandó o el form lo sabe. */
  problemaDe(campo: 'nombre' | 'contacto' | 'telefono'): string | null {
    const control = this.forma.controls[campo];
    if (control.hasError('requerido')) return 'Este campo es obligatorio.';
    if (control.hasError('maxlength')) return 'Es más largo de lo permitido.';
    if (control.hasError('duplicado')) return 'Ya existe un proveedor con este nombre.';
    return null;
  }

  /** Alta o edicion: lo decide `esAlta`. El `activo` no se manda. */
  async guardar(): Promise<void> {
    if (this.guardando() || this.forma.invalid) return;

    this.guardando.set(true);
    this.errorEditor.set(null);
    const cuerpo = cuerpoDeProveedor(this.forma.getRawValue());

    try {
      const actual = this.editando();
      if (actual === null) return;
      if (actual.id === undefined) {
        await this.api.crear(cuerpo);
      } else {
        await this.api.actualizar(actual.id, cuerpo);
      }
      this.editando.set(null);
      await this.recargar();
    } catch (falla) {
      const legible = errorLegible(falla);
      // El nombre repetido se marca en el campo, no solo en el aviso de
      // arriba: el operador tiene que saber QUAL campo corregir.
      if (legible.codigo === 'PROVEEDOR_DUPLICADO') {
        this.forma.controls.nombre.setErrors({ duplicado: true });
      }
      this.errorEditor.set(legible.mensaje);
    } finally {
      this.guardando.set(false);
    }
  }

  /**
   * Da de baja o reactiva desde la fila, sin abrir el editor.
   *
   * No pregunta nada: no se borra nada y el historial del proveedor (sus
   * compras) sigue ahí. Lo que se pierde es la posibilidad de elegirlo en
   * una compra nueva, y eso se deshace con el mismo boton.
   */
  async alternarActivo(proveedor: ProveedorListado): Promise<void> {
    if (this.guardando()) return;
    this.guardando.set(true);
    this.error.set(null);
    try {
      await this.api.alternarActivo(proveedor.id, !proveedor.activo);
      await this.recargar();
    } catch (falla) {
      this.error.set(errorLegible(falla).mensaje);
    } finally {
      this.guardando.set(false);
    }
  }
}
