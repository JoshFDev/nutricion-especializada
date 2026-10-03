import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  signal,
  viewChild,
  type OnInit,
} from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { LowerCasePipe } from '@angular/common';
import { errorLegible } from '../nucleo/api';
import { Sesion } from '../nucleo/sesion';
import { ToastService } from '../nucleo/toast.service';
import { ConfirmModal } from '../productos/confirm-modal';
import {
  CatalogoApi,
  cuerpoDeCatalogo,
  permisoDe,
  type ClaveRecurso,
  type FilaCatalogo,
} from './catalogo-api';

/**
 * La pantalla de Especies y Categorias.
 *
 * Es LA MISMA pantalla para las dos tablas, igual que el backend usa la
 * misma fabrica para sus rutas: lo unico que cambia es el recurso y el
 * titulo, y eso llega por `@Input` desde el wrapper de cada ruta
 * (`especies.ts` y `categorias.ts`). El resto —el listado, el editor de
 * nombre, el borrado con su confirmacion— es identico porque en la base lo
 * es.
 *
 * Son listas CHICAS, sin filtros ni paginacion: se traen enteras y se
 * pintan. El editor solo tiene nombre porque eso es todo lo que tiene la
 * tabla (id + nombre), y el nombre debe ser unico: el backend responde
 * `NOMBRE_DUPLICADO` y eso se pega al campo, como el codigo en clientes.
 */

@Component({
  selector: 'app-catalogo',
  templateUrl: './catalogo.html',
  styleUrl: './catalogo.scss',
  imports: [ReactiveFormsModule, ConfirmModal, LowerCasePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Catalogo implements OnInit {
  /** `'especies'` o `'categorias'`. Lo decide el wrapper de cada ruta. */
  readonly recurso = input.required<ClaveRecurso>();
  readonly titulo = input.required<string>();
  /**
   * El nombre en singular, para los mensajes.
   *
   * Va aparte del `titulo` porque los mensajes necesitan concordar
   * ("Categoría creada", no "Categorias creada") y `titulo` llega en
   * plural. Los dos son femeninos, asi que el genero no hace falta.
   */
  readonly singular = input.required<string>();

  private readonly api = inject(CatalogoApi);
  private readonly fb = inject(FormBuilder);
  private readonly sesion = inject(Sesion);
  private readonly toast = inject(ToastService);

  // ------------------------------------------------------------- el listado
  readonly filas = signal<FilaCatalogo[]>([]);
  readonly cargando = signal(false);
  readonly error = signal<string | null>(null);

  // -------------------------------------------------------------- el editor
  readonly editando = signal<FilaCatalogo | null>(null);
  readonly guardando = signal(false);
  readonly errorEditor = signal<string | null>(null);

  /**
   * Si el editor esta desplegado, separado de que fila se esta editando.
   *
   * El boton de la cabecera es el que lo alterna, igual que en productos: el
   * listado se queda debajo y no desaparece, para no perder de vista lo que
   * se esta Laplacando.
   */
  readonly editorVisible = signal(false);

  readonly editorAbierto = computed(() => this.editorVisible());
  /** Alta o renombrado: el id dice cual. */
  readonly esAlta = computed(() => this.editando()?.id === undefined);

  readonly confirmModal = viewChild.required(ConfirmModal);

  /** El boton de borrar solo se dibuja con el permiso, como en clientes. */
  readonly puedeEliminar = computed(() => this.sesion.puede(permisoDe(this.recurso(), 'eliminar')));
  readonly puedeCrear = computed(() => this.sesion.puede(permisoDe(this.recurso(), 'crear')));

  /** El formulario del editor. Solo nombre: es lo unico que tiene la tabla. */
  readonly forma = this.fb.nonNullable.group({
    nombre: ['', [Validators.required, Validators.maxLength(100)]],
  });

  /**
   * Carga al empezar.
   *
   * En el constructor `this.recurso()` todavia no tiene valor —los inputs
   * se asignan despues de construirse la instancia— y leer un `required()`
   * ahi lanza el error de la app y deja la pantalla en blanco hasta que una
   * accion (agregar un registro) dispara otro `recargar()`. Por eso el
   * primer listado se pide en `ngOnInit`, que ya corre con los inputs.
   */
  ngOnInit(): void {
    void this.recargar();
  }

  // ------------------------------------------------------------- el listado

  private async recargar(): Promise<void> {
    this.cargando.set(true);
    this.error.set(null);
    try {
      this.filas.set(await this.api.listar(this.recurso()));
    } catch (falla) {
      this.error.set(errorLegible(falla).mensaje);
    } finally {
      this.cargando.set(false);
    }
  }

  // -------------------------------------------------------------- el editor

  abrirNuevo(): void {
    this.forma.reset({ nombre: '' });
    this.errorEditor.set(null);
    this.editando.set({} as FilaCatalogo);
    this.editorVisible.set(true);
  }

  renombrar(fila: FilaCatalogo): void {
    this.forma.setValue({ nombre: fila.nombre });
    this.errorEditor.set(null);
    this.editando.set(fila);
    this.editorVisible.set(true);
  }

  /**
   * El boton de la cabecera.
   *
   * Desplegar siempre abre un alta, no el renombrado de lo que hubiera
   * quedado a medias: si el usuario cierra el editor a medias y vuelve a
   * pulsar, lo espera es un formulario limpio, no el nombre a medias con el
   * que se equivoco antes.
   */
  alternarEditor(): void {
    if (this.editorVisible()) {
      this.cancelar();
      return;
    }
    this.abrirNuevo();
  }

  cancelar(): void {
    this.editando.set(null);
    this.editorVisible.set(false);
    this.errorEditor.set(null);
    this.forma.reset({ nombre: '' });
  }

  /** Alta o renombrado, lo decide `esAlta`. */
  async guardar(): Promise<void> {
    if (this.guardando() || this.forma.invalid) return;

    this.guardando.set(true);
    this.errorEditor.set(null);
    const { nombre } = cuerpoDeCatalogo(this.forma.getRawValue().nombre);

    try {
      const actual = this.editando();
      if (actual === null) return;
      if (actual.id === undefined) {
        await this.api.crear(this.recurso(), nombre);
        this.toast.exito(`${this.singular()} creada con éxito`);
      } else {
        await this.api.renombrar(this.recurso(), actual.id, nombre);
        this.toast.exito(`${this.singular()} guardada con éxito`);
      }
      this.editando.set(null);
      this.editorVisible.set(false);
      this.forma.reset({ nombre: '' });
      await this.recargar();
    } catch (falla) {
      const legible = errorLegible(falla);
      if (legible.codigo === 'NOMBRE_DUPLICADO') {
        this.forma.controls.nombre.setErrors({ duplicado: true });
      }
      this.errorEditor.set(legible.mensaje);
    } finally {
      this.guardando.set(false);
    }
  }

/**
   * Borra.
   *
   * El backend no deja borrar lo que ya se uso (los FK no tienen ON
   * DELETE) y responde 409 EN_USO con el detalle de quién la usa. Se
   * confirma primero porque no hay "dar de baja" en estas tablas: o se
   * borra o no se toca.
   *
   * La confirmacion va por el modal, no por `window.confirm`: el del
   * navegador no se puede estilar, no cabe el texto largo que devuelve el
   * 409 y en una pantalla de mostrador se pierde detras de otra ventana.
   */
  async eliminar(fila: FilaCatalogo): Promise<void> {
    const confirmado = await this.confirmModal().abrir({
      titulo: `Eliminar ${this.singular().toLowerCase()}`,
      mensaje: `¿Eliminar "${fila.nombre}"? No se puede si ya se está usando.`,
      textoConfirmar: 'Eliminar',
      variante: 'peligro',
    });
    if (!confirmado) return;

    this.error.set(null);
    try {
      await this.api.eliminar(this.recurso(), fila.id);
      this.toast.exito(`${this.singular()} eliminada con éxito`);
      await this.recargar();
    } catch (falla) {
      const legible = errorLegible(falla);
      this.error.set(legible.mensaje);
      this.toast.error(legible.mensaje);
    }
  }
}
