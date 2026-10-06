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
import { filasAnimation, Recarga } from '../nucleo/animaciones';
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

/**
 * El filtro de uso del listado.
 *
 * `todas` es lo que sale por defecto; los otros dos ya contestan la
 * pregunta que uno se hace al abrir el catalogo, que es "de esto, ¿que
 * puedo quitar?".
 */
type FiltroUso = 'todas' | 'en-uso' | 'sin-uso';

@Component({
  selector: 'app-catalogo',
  templateUrl: './catalogo.html',
  styleUrl: './catalogo.scss',
  imports: [ReactiveFormsModule, ConfirmModal, LowerCasePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  animations: [filasAnimation],
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
  /** Para la cascada de entrada de la tabla. Ver `nucleo/animaciones.ts`. */
  readonly recarga = new Recarga();

  readonly filas = signal<FilaCatalogo[]>([]);
  readonly total = signal(0);
  readonly limite = signal(25);
  readonly pagina = signal(1);
  readonly buscador = signal('');
  readonly cargando = signal(false);
  readonly exportando = signal(false);
  readonly error = signal<string | null>(null);

  /**
   * El filtro de uso: cuales de las entradas se ven.
   *
   * `todas` es lo que sale por defecto. Es el filtro que mas se usa de los
   * dos, porque el catalogo tiene dos trabajos distintos: dar de alta lo
   * que falta, y quitar lo que sobra. Para lo segundo lo primero que hay
   * que saber es si algo lo esta usando, y eso no se deduce del nombre.
   */
  readonly filtroUso = signal<FiltroUso>('todas');

  /** Cuantas paginas hay, con el tamano de pagina elegido. */
  readonly paginasTotales = computed(() => Math.max(1, Math.ceil(this.total() / this.limite())));
  readonly hayPaginaAnterior = computed(() => this.pagina() > 1);
  readonly hayPaginaSiguiente = computed(() => this.pagina() < this.paginasTotales());

  /** Que se ve en la barra: "1-25 de 40". */
  readonly rangoDePagina = computed(() => {
    const total = this.total();
    if (total === 0) return '0 de 0';
    const desde = (this.pagina() - 1) * this.limite() + 1;
    const hasta = Math.min(this.pagina() * this.limite(), total);
    return `${desde}-${hasta} de ${total}`;
  });

  /** Si el listado lleva algo puesto, para poder ofrecer "Limpiar". */
  readonly hayFiltros = computed(
    () => this.buscador().trim() !== '' || this.filtroUso() !== 'todas',
  );

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
      const datos = await this.api.listar(this.recurso());
      this.filas.set(datos);
      this.total.set(datos.length);
      this.pagina.set(1);
      this.aplicarFiltro();
    } catch (falla) {
      this.error.set(errorLegible(falla).mensaje);
    } finally {
      this.cargando.set(false);
    }
  }

  /**
   * Filtra y pagina en el cliente.
   *
   * El catalogo se trae ENTERO y se filtra aqui, no en el backend: son una
   * docena de filas y el backend no acepta filtros en estas rutas
   * (`catalogo/rutas.ts`). Con ese tamaño, filtrar en el navegador es
   * instantáneo y no se pierde nada.
   */
  private aplicarFiltro(): void {
    const texto = this.buscador().trim().toLowerCase();
    const uso = this.filtroUso();

    const filtradas = this.filas().filter((f) => {
      if (texto !== '' && !f.nombre.toLowerCase().includes(texto)) return false;
      if (uso === 'en-uso') return f.usos > 0;
      if (uso === 'sin-uso') return f.usos === 0;
      return true;
    });

    this.total.set(filtradas.length);

    // Si el filtro deja menos paginas de las que estabas viendo, se baja a
    // la ultima que queda: si no, "Página 4 de 1" y una tabla vacia.
    const ultima = Math.max(1, Math.ceil(filtradas.length / this.limite()));
    const pagina = Math.min(this.pagina(), ultima);
    this.pagina.set(pagina);

    const inicio = (pagina - 1) * this.limite();
    this.filasVisibles.set(filtradas.slice(inicio, inicio + this.limite()));
    this.recarga.marcar();
  }

  /** Texto de busqueda (va con retardo, como en productos). */
  buscar(texto: string): void {
    clearTimeout(this.temporizador);
    this.buscador.set(texto);
    this.temporizador = setTimeout(() => {
      this.pagina.set(1);
      this.aplicarFiltro();
    }, 250);
  }

  /** Cambia el filtro de uso. */
  filtrarUso(valor: string): void {
    this.filtroUso.set(valor as FiltroUso);
    this.pagina.set(1);
    this.aplicarFiltro();
  }

  /** Quita busqueda y filtro de golpe, y vuelve a la primera pagina. */
  limpiarFiltros(): void {
    clearTimeout(this.temporizador);
    this.buscador.set('');
    this.filtroUso.set('todas');
    this.pagina.set(1);
    this.aplicarFiltro();
  }

  /** Cambia de pagina. */
  async irPagina(pagina: number): Promise<void> {
    if (pagina < 1 || pagina > this.paginasTotales() || pagina === this.pagina()) return;
    this.pagina.set(pagina);
    this.aplicarFiltro();
    document.querySelector('.catalogo .tabla-wrapper')?.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    });
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

  /** Cambia cuantos registros se ven por pagina. */
  async aTamanoDePagina(valor: string): Promise<void> {
    this.limite.set(Number(valor));
    this.pagina.set(1);
    this.aplicarFiltro();
  }

  /** Resto visible actual. */
  readonly filasVisibles = signal<FilaCatalogo[]>([]);

  private temporizador: ReturnType<typeof setTimeout> | undefined;

  /**
   * El conteo de usos en texto: "3 usos", "1 uso".
   *
   * Va como texto y no con un numero suelto porque el número solo no dice
   * de qué: parece un precio o una cantidad de productos, que es
   * justamente lo que el operador cree que está viendo.
   */
  usoDe(fila: FilaCatalogo): string {
    return fila.usos === 1 ? '1 uso' : `${fila.usos} usos`;
  }

  /** Exporta a Excel. */
  async exportarExcel(): Promise<void> {
    if (this.exportando()) return;
    this.exportando.set(true);
    try {
      await this.api.exportarExcel(this.recurso());
      this.toast.exito(`${this.titulo()} exportado a Excel`);
    } catch (falla) {
      const legible = errorLegible(falla);
      this.toast.error(legible.mensaje);
    } finally {
      this.exportando.set(false);
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

  /**
   * Enter guarda el editor, Escape lo cierra. Igual que en productos y
   * precios: son las dos teclas de un formulario de un solo campo, y sin
   * esto hay que llegar al ratón para confirmar.
   */
  onKeydown(evento: KeyboardEvent): void {
    if (evento.key === 'Escape' && this.editorVisible()) {
      evento.preventDefault();
      this.cancelar();
      return;
    }
    if (evento.key === 'Enter' && this.editorVisible() && !this.guardando()) {
      evento.preventDefault();
      void this.guardar();
    }
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
