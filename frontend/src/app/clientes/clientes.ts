import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { trigger, transition, style, animate, query, stagger } from '@angular/animations';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { errorLegible } from '../nucleo/api';
import { Sesion } from '../nucleo/sesion';
import { ToastService } from '../nucleo/toast.service';
import { montoComoTexto } from '../nucleo/cifras';
import { ConfirmModal } from '../productos/confirm-modal';
import { ClientesApi, cuerpoDeCliente, type Cliente, type Especie } from './clientes-api';

/**
 * La pantalla de clientes.
 *
 * Misma estructura que productos, precios y el catálogo, y por el mismo
 * motivo: el diseño está en `nucleo/pantallas.scss` y aquí solo queda lo que
 * es de clientes. Lo que cambia con el resto es el EDITOR, que vive ARRIBA
 * de la tabla y es colapsable en vez de sustituirla: antes, al darle a
 * "Nuevo cliente", se iba la tabla entera y con ella la lista de a quien se
 * le estaba copiando el código o el nombre.
 *
 * El listado pagina de verdad —antes era "cargar más", que pegaba las
 * siguientes al final y con doscientas filas era una tabla de cuatro
 * pantallas—. El editor es el mismo para el alta y la edición, y lo decide
 * `esAlta`, que mira si la fila trae id.
 *
 * Las reglas del editor son las del backend (`clientes/esquemas.ts`): el
 * código se pasa a mayúsculas, los campos opcionales en blanco se mandan
 * como `null`, y el estatus es 'Activo'/'Inactivo'. El RFC no se edita aquí:
 * la API de clientes no lo acepta (vive en `datos_fiscales_cliente`), por
 * eso el editor no lo muestra como campo, aunque la fila sí lo enseña.
 */

@Component({
  selector: 'app-clientes',
  templateUrl: './clientes.html',
  styleUrl: './clientes.scss',
  imports: [ReactiveFormsModule, ConfirmModal],
  changeDetection: ChangeDetectionStrategy.OnPush,
  animations: [
    trigger('filasAnimation', [
      transition('* => *', [
        query(
          ':enter',
          [
            style({ opacity: 0, transform: 'translateY(-10px)' }),
            stagger(50, [
              animate('300ms ease-out', style({ opacity: 1, transform: 'translateY(0)' })),
            ]),
          ],
          { optional: true },
        ),
        query(
          ':leave',
          [
            stagger(50, [
              animate('200ms ease-in', style({ opacity: 0, transform: 'translateX(20px)' })),
            ]),
          ],
          { optional: true },
        ),
      ]),
    ]),
  ],
})
export class Clientes {
  private readonly api = inject(ClientesApi);
  private readonly fb = inject(FormBuilder);
  private readonly sesion = inject(Sesion);
  private readonly toast = inject(ToastService);

  // ------------------------------------------------------------- el listado
  readonly filas = signal<Cliente[]>([]);
  readonly total = signal(0);
  readonly buscando = signal(false);
  readonly exportando = signal(false);
  readonly error = signal<string | null>(null);
  readonly buscador = signal('');
  readonly estatusFiltro = signal<'todos' | 'Activo' | 'Inactivo'>('todos');

  readonly especies = signal<Especie[]>([]);

  /**
   * Cuántos clientes se ven por página, y la página que se está viendo.
   *
   * La página se elige en SALTOS y se traduce a `offset` al pedir, porque un
   * `offset` guardado se queda viejo en cuanto cambia un filtro.
   */
  readonly limite = signal(25);
  readonly pagina = signal(1);

  readonly paginasTotales = computed(() => Math.max(1, Math.ceil(this.total() / this.limite())));
  readonly hayPaginaAnterior = computed(() => this.pagina() > 1);
  readonly hayPaginaSiguiente = computed(() => this.pagina() < this.paginasTotales());

  /** Que se ve en la barra: "1-25 de 240". */
  readonly rangoDePagina = computed(() => {
    const total = this.total();
    if (total === 0) return '0 de 0';
    const desde = (this.pagina() - 1) * this.limite() + 1;
    const hasta = Math.min(this.pagina() * this.limite(), total);
    return `${desde}-${hasta} de ${total}`;
  });

  /**
   * Si el listado lleva algo puesto, para poder ofrecer "Limpiar".
   *
   * El buscador se cuenta con dos caracteres y no con que tenga algo: el
   * backend ignora lo que no llega a dos, así que un "a" escrito se ve en el
   * campo pero no está filtrando nada, y un "Limpiar" que aparece solo con
   * dos letras confunde más de lo que ayuda.
   */
  readonly hayFiltros = computed(
    () => this.buscador().trim().length >= 2 || this.estatusFiltro() !== 'todos',
  );

  // -------------------------------------------------------------- el editor
  readonly editando = signal<Cliente | null>(null);
  readonly guardando = signal(false);
  readonly errorEditor = signal<string | null>(null);

  /**
   * Si el editor está desplegado, separado de qué fila se está editando.
   *
   * El boton de la cabecera es el que lo alterna, igual que en productos: el
   * listado se queda debajo y no desaparece, para no perder de vista lo que
   * se está Laplacando.
   */
  readonly editorVisible = signal(false);

  readonly editorAbierto = computed(() => this.editorVisible());
  /** Alta o edición: el id lo dice. */
  readonly esAlta = computed(() => this.editando()?.id === undefined);

  readonly puedeCrear = computed(() => this.sesion.puede('clientes.crear'));
  readonly puedeEditar = computed(() => this.sesion.puede('clientes.editar'));
  readonly puedeEliminar = computed(() => this.sesion.puede('clientes.eliminar'));

  /**
   * Si el boton de guardar se puede pulsar.
   *
   * Son permisos DISTINTOS: el backend pide `clientes.crear` en el POST y
   * `clientes.editar` en el PATCH. Con los dos se guarda igual, así que el
   * editor se abre para quien tenga cualquiera de los dos, y lo que decide
   * esta signal es si lo que hay en el formulario es un alta o una
   * edición. Sin esto, alguien que solo puede editar tendria un formulario
   * con un boton que el backend va a rechazar con un 403.
   */
  readonly puedeGuardar = computed(() => (this.esAlta() ? this.puedeCrear() : this.puedeEditar()));

  readonly confirmModal = viewChild.required(ConfirmModal);

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

  /**
   * El mensaje de un campo, si el formulario lo sabe.
   *
   * El error va DEBAJO del campo y no solo en el aviso de arriba del
   * formulario: lo que hay que corregir es el campo, y un mensaje suelto
   * obliga a buscar cuál de los siete es.
   */
  problemaDe(campo: 'codigo_cliente' | 'nombre'): string | null {
    const control = this.forma.controls[campo];
    if (control.hasError('requerido')) return 'Este campo es obligatorio.';
    if (control.hasError('duplicado')) return 'Ya existe un cliente con ese código.';
    return null;
  }

  constructor() {
    void this.cargarEspecies();
    void this.recargar();
  }

  /** Las especies se cargan una sola vez: el catálogo no cambia entre editor y editor. */
  private async cargarEspecies(): Promise<void> {
    try {
      this.especies.set(await this.api.especies());
    } catch {
      // El catálogo de especies no bloquea la pantalla: si falla, el select
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

  /** Quita busqueda y filtro de golpe, y vuelve a la primera página. */
  limpiarFiltros(): void {
    clearTimeout(this.temporizador);
    this.buscador.set('');
    this.estatusFiltro.set('todos');
    void this.recargar();
  }

  /**
   * El texto de búsqueda, o `undefined` si es muy corto.
   *
   * El mínimo de DOS caracteres es el mismo de las otras pantallas: con uno
   * solo el `ILIKE '%a%'` del backend (`clientes/repositorio.ts`) trae medio
   * catálogo y la tabla deja de informar.
   */
  private textoBusqueda(): string | undefined {
    const limpio = this.buscador().trim();
    return limpio.length >= 2 ? limpio : undefined;
  }

  /**
   * El estatus que se manda a la API, o `undefined` si no se filtra.
   *
   * El desplegable lleva un "Todos" que no es un estatus: es la manera de
   * decir "no filtrar". Va aparte de `estatusFiltro` para no repetir el
   * `=== 'todos' ? undefined : ...` en cada petición, que además es el
   * truco que hace que la API acepte tres valores donde solo hay dos.
   */
  private readonly estatusConsulta = computed<'Activo' | 'Inactivo' | undefined>(() => {
    const estatus = this.estatusFiltro();
    return estatus === 'todos' ? undefined : estatus;
  });

  /** Vuelve a la primera página con el filtro que se tenga puesto. */
  private async recargar(): Promise<void> {
    await this.cargarPagina(1);
  }

  /** Carga una página. Es la ÚNICA forma de pedir clientes. */
  private async cargarPagina(pagina: number): Promise<void> {
    this.buscando.set(true);
    this.error.set(null);
    try {
      const resultado = await this.api.listar({
        buscar: this.textoBusqueda(),
        estatus: this.estatusConsulta(),
        limite: this.limite(),
        offset: (pagina - 1) * this.limite(),
      });

      // Se borró la última fila de la última página: la que se pide ya no
      // existe. Se retrocede una en vez de dejar una tabla vacía con el
      // contador diciendo "página 7 de 7". Solo cuando hay páginas antes, por
      // que en la primera lo que hay que mostrar es el estado vacío.
      if (resultado.datos.length === 0 && pagina > 1) {
        await this.cargarPagina(pagina - 1);
        return;
      }

      this.filas.set(resultado.datos);
      this.total.set(resultado.paginacion.total);
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
   * Cambia de página y sube la tabla a la vista.
   *
   * El scroll se queda donde estaba, y como la tabla está más abajo el
   * cambio de página no se ve: solo se mueve el número de la barra, que
   * puede estar fuera de pantalla.
   */
  async irPagina(pagina: number): Promise<void> {
    if (pagina < 1 || pagina > this.paginasTotales() || pagina === this.pagina()) return;
    await this.cargarPagina(pagina);
    document.querySelector('.clientes .tabla-wrapper')?.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    });
  }

  /**
   * El tamaño de página como texto, para el `[value]` del desplegable.
   *
   * En las plantillas de Angular no hay `String` global (si `JSON`, si
   * `Math`, pero no `String`), y `[value]` necesita texto: con un número, el
   * `value` del `select` no coincide con ninguna opcion y sale vacío.
   */
  limiteComoTexto(): string {
    return String(this.limite());
  }

  /**
   * Cambia cuantos registros se ven por página.
   *
   * Vuelve SIEMPRE a la página 1: quedarse en la 7 y pasar de 25 a 50 filas
   * es quedarse en un `offset` que ya no quiere decir nada.
   */
  async aTamanoDePagina(valor: string): Promise<void> {
    this.limite.set(Number(valor));
    await this.cargarPagina(1);
  }

  /** Exporta lo que hay filtrado, que puede ser más que una página. */
  async exportarExcel(): Promise<void> {
    if (this.exportando()) return;
    this.exportando.set(true);
    try {
      await this.api.exportarExcel({
        buscar: this.textoBusqueda(),
        estatus: this.estatusConsulta(),
      });
      this.toast.exito('Clientes exportados a Excel');
    } catch (falla) {
      this.toast.error(errorLegible(falla).mensaje);
    } finally {
      this.exportando.set(false);
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
    this.editorVisible.set(true);
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
    this.editorVisible.set(true);
  }

  /**
   * El boton de la cabecera.
   *
   * Desplegar siempre abre un alta, no la edición de lo que hubiera quedado
   * a medias: si el usuario cierra el editor a medias y vuelve a pulsar, lo
   * espera es un formulario limpio, no el cliente a medias con el que se
   * equivocó antes.
   */
  alternarEditor(): void {
    if (this.editorVisible()) {
      this.cancelar();
      return;
    }
    this.nuevo();
  }

  cancelar(): void {
    this.editando.set(null);
    this.editorVisible.set(false);
    this.errorEditor.set(null);
  }

  /**
   * Enter guarda el editor, Escape lo cierra. Igual que en el catálogo y en
   * productos: son las dos teclas de un formulario, y sin esto hay que
   * llegar al raton para confirmar.
   */
  onKeydown(evento: KeyboardEvent): void {
    if (!this.editorVisible()) return;
    if (evento.key === 'Escape') {
      evento.preventDefault();
      this.cancelar();
      return;
    }
    if (evento.key === 'Enter' && !this.guardando()) {
      evento.preventDefault();
      void this.guardar();
    }
  }

  /** Alta o edición: lo decide `esAlta`, que ya viene de la signal. */
  async guardar(): Promise<void> {
    if (this.guardando() || !this.puedeGuardar()) return;

    this.forma.markAllAsTouched();
    if (this.forma.invalid) return;

    this.guardando.set(true);
    this.errorEditor.set(null);
    const cuerpo = cuerpoDeCliente(this.forma.getRawValue());

    try {
      const actual = this.editando();
      if (actual === null) return;
      if (actual.id === undefined) {
        await this.api.crear(cuerpo);
        this.toast.exito('Cliente creado con éxito');
      } else {
        await this.api.actualizar(actual.id, cuerpo);
        this.toast.exito('Cliente guardado con éxito');
      }
      this.cancelar();
      await this.recargar();
    } catch (falla) {
      const legible = errorLegible(falla);
      // El código repetido se marca en el campo, no solo en el aviso de
      // arriba: el operador tiene que saber QUÉ campo corregir.
      if (legible.codigo === 'CODIGO_DUPLICADO') {
        this.forma.controls.codigo_cliente.setErrors({ duplicado: true });
      }
      this.errorEditor.set(legible.mensaje);
    } finally {
      this.guardando.set(false);
    }
  }

  /**
   * Borra.
   *
   * Va por el modal y no por `window.confirm`: el del navegador no se puede
   * estilar y el mensaje de un 409 (que el backend devuelve cuando el
   * cliente ya tiene notas o pagos) no cabe en su caja.
   */
  async eliminar(cliente: Cliente): Promise<void> {
    const confirmado = await this.confirmModal().abrir({
      titulo: 'Eliminar cliente',
      mensaje: `¿Eliminar a ${cliente.nombre}? Esta acción es irreversible.\n\nSi tiene notas de remisión o pagos, no se podrá eliminar. En ese caso se recomienda marcarlo como Inactivo para dejar de usarlo sin perder el historial.`,
      textoConfirmar: 'Eliminar',
      variante: 'peligro',
    });
    if (!confirmado) return;

    this.error.set(null);
    try {
      await this.api.eliminar(cliente.id);
      this.toast.exito('Cliente eliminado con éxito');
      await this.cargarPagina(this.pagina());
    } catch (falla) {
      const legible = errorLegible(falla);
      if (legible.codigo === 'EN_USO') {
        this.toast.advertencia(legible.mensaje);
      } else {
        this.error.set(legible.mensaje);
        this.toast.error(legible.mensaje);
      }
    }
  }
}
