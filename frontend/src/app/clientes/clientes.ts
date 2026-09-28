import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { errorLegible } from '../nucleo/api';
import { Sesion } from '../nucleo/sesion';
import { montoComoTexto } from '../nucleo/cifras';
import { ClientesApi, cuerpoDeCliente, type Cliente, type Especie } from './clientes-api';

/**
 * La pantalla de clientes.
 *
 * Dos estados en una vista: el LISTADO (busqueda + tabla) y el EDITOR del
 * cliente. Se decide con la signal `editando`: cuando es `null` se ve el
 * listado, y cuando trae un cliente se ve el editor para editar; `nuevo()`
 * pone un cliente vacio en esa misma signal y el editor sabe distinguir el
 * alta de la edicion por `cliente.id`.
 *
 * Las reglas del editor son las del backend (`clientes/esquemas.ts`): el
 * codigo se pasa a mayusculas, los campos opcionales en blanco se mandan
 * como `null`, y el estatus es 'Activo'/'Inactivo'. El RFC no se edita aqui:
 * la API de clientes no lo acepta (vive en `datos_fiscales_cliente`), por
 * eso el editor no lo muestra como campo.
 */

@Component({
  selector: 'app-clientes',
  templateUrl: './clientes.html',
  styleUrl: './clientes.scss',
  imports: [ReactiveFormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Clientes {
  private readonly api = inject(ClientesApi);
  private readonly fb = inject(FormBuilder);
  private readonly sesion = inject(Sesion);

  // ------------------------------------------------------------- el listado
  readonly filas = signal<Cliente[]>([]);
  readonly total = signal(0);
  readonly offset = signal(0);
  readonly buscando = signal(false);
  readonly error = signal<string | null>(null);
  readonly buscador = signal('');
  readonly estatusFiltro = signal<'todos' | 'Activo' | 'Inactivo'>('todos');

  readonly especies = signal<Especie[]>([]);

  readonly hayMas = computed(() => this.filas().length < this.total());

  // -------------------------------------------------------------- el editor
  readonly editando = signal<Cliente | null>(null);
  readonly guardando = signal(false);
  readonly errorEditor = signal<string | null>(null);

  /** La signal `editando` como "hay editor abierto". */
  readonly editorAbierto = computed(() => this.editando() !== null);

  readonly esAlta = computed(() => this.editando()?.id === undefined);

  readonly puedeCrear = computed(() => this.sesion.puede('clientes.crear'));
  readonly puedeEditar = computed(() => this.sesion.puede('clientes.editar'));
  readonly puedeEliminar = computed(() => this.sesion.puede('clientes.eliminar'));

  /** El formulario del editor. */
  readonly forma = this.fb.nonNullable.group({
    codigo_cliente: ['', Validators.required],
    nombre: ['', Validators.required],
    establo: [''],
    especie_id: [''],
    estatus: this.fb.nonNullable.control<'Activo' | 'Inactivo'>('Activo'),
    telefono: [''],
    direccion: [''],
  });

  montoComoTexto = montoComoTexto;

  constructor() {
    void this.cargarEspecies();
    void this.recargar();
  }

  /** Las especies se cargan una sola vez: el catalogo no cambia entre editor y editor. */
  private async cargarEspecies(): Promise<void> {
    try {
      this.especies.set(await this.api.especies());
    } catch {
      // El catalogo de especies no bloquea la pantalla: si falla, el select
      // queda con la opcion "sin especie" habilitada y el error se vera al guardar.
      this.especies.set([]);
    }
  }

  // ------------------------------------------------------------- el listado

  private temporizador: ReturnType<typeof setTimeout> | undefined;

  /** Busca con 250 ms de espera, igual que el POS (ver `notas.ts`). */
  buscar(texto: string): void {
    clearTimeout(this.temporizador);
    this.buscador.set(texto);
    this.temporizador = setTimeout(() => void this.recargar(), 250);
  }

  filtrar(estatus: string): void {
    this.estatusFiltro.set(estatus as 'todos' | 'Activo' | 'Inactivo');
    void this.recargar();
  }

  /** Carga la primera pagina con los filtros actuales. */
  private async recargar(): Promise<void> {
    this.buscando.set(true);
    this.error.set(null);
    try {
      const buscar = this.buscador().trim();
      const filtro = this.estatusFiltro();
      const estatus = filtro === 'todos' ? undefined : filtro;
      const resultado = await this.api.listar({
        buscar: buscar.length >= 2 ? buscar : undefined,
        estatus,
      });
      this.filas.set(resultado.datos);
      this.total.set(resultado.paginacion.total);
      this.offset.set(resultado.paginacion.offset);
    } catch (falla) {
      this.error.set(errorLegible(falla).mensaje);
    } finally {
      this.buscando.set(false);
    }
  }

  /** La pagina siguiente se agrega a la lista, no la reemplaza. */
  async cargarMas(): Promise<void> {
    if (this.buscando()) return;
    this.buscando.set(true);
    try {
      const buscar = this.buscador().trim();
      const filtro = this.estatusFiltro();
      const estatus = filtro === 'todos' ? undefined : filtro;
      const resultado = await this.api.listar({
        buscar: buscar.length >= 2 ? buscar : undefined,
        estatus,
        offset: this.offset() + this.filas().length,
      });
      this.filas.update((actuales) => [...actuales, ...resultado.datos]);
      this.total.set(resultado.paginacion.total);
    } catch (falla) {
      this.error.set(errorLegible(falla).mensaje);
    } finally {
      this.buscando.set(false);
    }
  }

  // -------------------------------------------------------------- el editor

  nuevo(): void {
    this.forma.reset({
      codigo_cliente: '',
      nombre: '',
      establo: '',
      especie_id: '',
      estatus: 'Activo',
      telefono: '',
      direccion: '',
    });
    this.errorEditor.set(null);
    this.editando.set({} as Cliente);
  }

  editar(cliente: Cliente): void {
    this.forma.setValue({
      codigo_cliente: cliente.codigo_cliente ?? '',
      nombre: cliente.nombre,
      establo: cliente.establo ?? '',
      especie_id: cliente.especie_id === null ? '' : String(cliente.especie_id),
      estatus: cliente.estatus,
      telefono: cliente.telefono ?? '',
      direccion: cliente.direccion ?? '',
    });
    this.errorEditor.set(null);
    this.editando.set(cliente);
  }

  cancelar(): void {
    this.editando.set(null);
    this.errorEditor.set(null);
  }

  /** Alta o edicion: lo decide `esAlta`, que ya viene de la signal. */
  async guardar(): Promise<void> {
    if (this.guardando() || this.forma.invalid) return;

    this.guardando.set(true);
    this.errorEditor.set(null);
    const cuerpo = cuerpoDeCliente(this.forma.getRawValue());

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
      if (legible.codigo === 'CODIGO_DUPLICADO') {
        this.forma.controls.codigo_cliente.setErrors({ duplicado: true });
      }
      this.errorEditor.set(legible.mensaje);
    } finally {
      this.guardando.set(false);
    }
  }

  async eliminar(cliente: Cliente): Promise<void> {
    if (!window.confirm(`Eliminar a ${cliente.nombre}? Esta accion no se puede deshacer.`)) return;
    this.error.set(null);
    try {
      await this.api.eliminar(cliente.id);
      await this.recargar();
    } catch (falla) {
      this.error.set(errorLegible(falla).mensaje);
    }
  }
}
