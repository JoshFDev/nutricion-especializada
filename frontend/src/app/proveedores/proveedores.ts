import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { filasAnimation, Recarga } from '../nucleo/animaciones';
import { errorLegible } from '../nucleo/api';
import { Sesion } from '../nucleo/sesion';
import { ToastService } from '../nucleo/toast.service';
import { montoComoTexto } from '../nucleo/cifras';
import { ProveedoresApi, cuerpoDeProveedor, type ProveedorListado } from './proveedores-api';

/**
 * La pantalla de proveedores.
 *
 * Misma estructura que clientes, productos, precios y el catálogo, y por el
 * mismo motivo: el diseño está en `nucleo/pantallas.scss` y aquí solo queda
 * lo que es de proveedores. Antes el editor era una pantalla aparte —al
 * darle a "Nuevo proveedor" se iba la tabla— y el listado era "cargar más",
 * que pegaba las siguientes al final; ahora el editor se despliega ARRIBA de
 * la tabla y la lista pagina de verdad.
 *
 * Tres reglas que vienen del backend (`proveedores/esquemas.ts`) y que no
 * conviene rediseñar:
 *
 *   - **No hay borrar.** Un proveedor con compras tiene su nombre impreso en
 *     documentos viejos, así que la baja es `activo: false` por PATCH desde
 *     la fila, no un DELETE. Por eso esta pantalla no usa el modal de
 *     confirmación de productos: no hay nada irreversible que preguntar.
 *   - **El nombre es la llave.** Es UNIQUE en la base y el servicio responde
 *     `PROVEEDOR_DUPLICADO`, que se pega al campo y no solo al aviso de
 *     arriba. En una compra el proveedor se elige por nombre.
 *   - **Alta y edición piden el MISMO permiso** (`proveedores.editar`), que es
 *     el único de la tabla, así que no hay `puedeCrear` y `puedeEditar` como
 *     en clientes: aquí alcanza con `puedeGuardar`.
 *
 * El saldo no se edita: lo recalcula la base con las compras y los pagos, y
 * por eso la columna es de solo lectura y el formulario no lo tiene.
 *
 * El listado sale por omisión con SOLO los activos: un proveedor dado de baja
 * no debe aparecer al capturar una compra, y esa es la consulta que se hace
 * casi siempre.
 */

@Component({
  selector: 'app-proveedores',
  templateUrl: './proveedores.html',
  styleUrl: './proveedores.scss',
  imports: [ReactiveFormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  animations: [filasAnimation],
})
export class Proveedores {
  private readonly api = inject(ProveedoresApi);
  private readonly fb = inject(FormBuilder);
  private readonly sesion = inject(Sesion);
  private readonly toast = inject(ToastService);

  // ------------------------------------------------------------- el listado
  /** Para la cascada de entrada de la tabla. Ver `nucleo/animaciones.ts`. */
  readonly recarga = new Recarga();

  readonly filas = signal<ProveedorListado[]>([]);
  readonly total = signal(0);
  readonly buscando = signal(false);
  readonly exportando = signal(false);
  readonly error = signal<string | null>(null);
  readonly buscador = signal('');
  readonly filtroActivo = signal<'activos' | 'inactivos' | 'todos'>('activos');

  /**
   * Cuántos proveedores se ven por página, y la página que se está viendo.
   *
   * La página se elige en SALTOS y se traduce a `offset` al pedir, porque un
   * `offset` guardado se queda viejo en cuanto cambia un filtro.
   */
  readonly limite = signal(25);
  readonly pagina = signal(1);

  readonly paginasTotales = computed(() => Math.max(1, Math.ceil(this.total() / this.limite())));
  readonly hayPaginaAnterior = computed(() => this.pagina() > 1);
  readonly hayPaginaSiguiente = computed(() => this.pagina() < this.paginasTotales());

  /** Lo que ve en la barra: "1-25 de 240". */
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
   * La referencia es `activos`, que es como se ve al entrar: "Limpiar" deja
   * la pantalla como se encontró, y no como se vino. El buscador se cuenta
   * con dos caracteres porque es lo que el backend exige: con uno solo no
   * filtra, y un "Limpiar" que aparece a la primera letra confunde más de lo
   * que ayuda.
   */
  readonly hayFiltros = computed(
    () => this.buscador().trim().length >= 2 || this.filtroActivo() !== 'activos',
  );

  // -------------------------------------------------------------- el editor
  readonly editando = signal<ProveedorListado | null>(null);
  readonly editorVisible = signal(false);
  readonly guardando = signal(false);
  readonly errorEditor = signal<string | null>(null);

  readonly esAlta = computed(() => this.editando()?.id === undefined);

  /**
   * Si el botón de guardar se puede pulsar.
   *
   * El alta y la edición piden el mismo permiso (`proveedores.editar`), así
   * que aquí no hay que mirar qué se está editando: basta con el permiso.
   */
  readonly puedeGuardar = computed(() => this.sesion.puede('proveedores.editar'));

  /** El formulario del editor. El `activo` NO va aquí: lo pone la base. */
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

  /**
   * Busca con 250 ms de espera, igual que el resto de las pantallas.
   *
   * Cada tecleo NO pega una petición: con el buscador abierto a media
   * escritura son varias y la última es la única que sirve. Además, buscar
   * siempre vuelve a la página 1, porque quedarse en la 4 con un filtro
   * nuevo es mirar un `offset` que ya no quiere decir nada.
   */
  buscar(texto: string): void {
    clearTimeout(this.temporizador);
    this.buscador.set(texto);
    this.temporizador = setTimeout(() => void this.recargar(), 250);
  }

  /** Cambia el filtro de estado. También vuelve a la primera página. */
  filtrar(activo: string): void {
    this.filtroActivo.set(activo as 'activos' | 'inactivos' | 'todos');
    void this.recargar();
  }

  /** Deja el buscador y el filtro como estaban al entrar. */
  limpiarFiltros(): void {
    clearTimeout(this.temporizador);
    this.buscador.set('');
    this.filtroActivo.set('activos');
    void this.recargar();
  }

  /**
   * El texto de búsqueda, o `undefined` si es muy corto.
   *
   * El mínimo de DOS caracteres es el mismo de las otras pantallas: con uno
   * solo el `ILIKE '%a%'` del backend (`proveedores/repositorio.ts`) trae
   * medio catálogo y la tabla deja de informar.
   */
  private textoBusqueda(): string | undefined {
    const limpio = this.buscador().trim();
    return limpio.length >= 2 ? limpio : undefined;
  }

  /** Vuelve a la primera página con el filtro que se tenga puesto. */
  private async recargar(): Promise<void> {
    await this.cargarPagina(1);
  }

  /** Carga una página. Es la ÚNICA forma de pedir proveedores. */
  private async cargarPagina(pagina: number): Promise<void> {
    this.buscando.set(true);
    this.error.set(null);
    try {
      const resultado = await this.api.listar({
        buscar: this.textoBusqueda(),
        activo: this.filtroActivo(),
        limite: this.limite(),
        offset: (pagina - 1) * this.limite(),
      });

      // Se dio de baja o se borró la última fila de la última página: la que
      // se pide ya no existe. Se retrocede una en vez de dejar una tabla
      // vacía con el contador diciendo "página 7 de 7".
      if (resultado.datos.length === 0 && pagina > 1) {
        await this.cargarPagina(pagina - 1);
        return;
      }

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

  /** Cambia de página y sube la tabla a la vista. */
  async irPagina(pagina: number): Promise<void> {
    if (pagina < 1 || pagina > this.paginasTotales() || pagina === this.pagina()) return;

    await this.cargarPagina(pagina);
    document.querySelector('.proveedores .tabla-wrapper')?.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    });
  }

  /** El tamaño de página como texto, para el `[value]` del desplegable. */
  limiteComoTexto(): string {
    return String(this.limite());
  }

  /** Cambia cuántos registros se ven por página. */
  aTamanoDePagina(valor: string): void {
    const limite = Number(valor);
    if (!Number.isFinite(limite) || limite <= 0 || limite === this.limite()) return;

    this.limite.set(limite);
    // Vuelve SIEMPRE a la página 1: quedarse en la 7 y pasar de 25 a 50
    // filas es pedir un `offset` que ya no corresponde a nada.
    void this.recargar();
  }

  /** Exporta a Excel lo que hay filtrado, no la página que se ve. */
  async exportarExcel(): Promise<void> {
    if (this.exportando()) return;

    this.exportando.set(true);
    try {
      await this.api.exportarExcel({
        buscar: this.textoBusqueda(),
        activo: this.filtroActivo(),
      });
      this.toast.exito('Proveedores exportados con éxito');
    } catch (falla) {
      this.toast.error(errorLegible(falla).mensaje);
    } finally {
      this.exportando.set(false);
    }
  }

  // -------------------------------------------------------------- el editor

  /**
   * Abrir y cerrar el editor desde el botón de la cabecera.
   *
   * Desplegar siempre abre un ALTA, no la edición de lo que hubiera quedado
   * a medias: si el operador cierra el editor sin guardar y vuelve a pulsar,
   * lo que espera es un formulario limpio, no el proveedor a medio escribir.
   */
  alternarEditor(): void {
    if (this.editorVisible()) {
      this.cancelar();
      return;
    }
    this.nuevo();
  }

  nuevo(): void {
    this.forma.reset({ nombre: '', contacto: '', telefono: '' });
    this.errorEditor.set(null);
    // Sin id: el editor sabe que es alta (ver `esAlta`).
    this.editando.set({} as ProveedorListado);
    this.editorVisible.set(true);
  }

  editar(proveedor: ProveedorListado): void {
    this.forma.setValue({
      nombre: proveedor.nombre,
      contacto: proveedor.contacto ?? '',
      telefono: proveedor.telefono ?? '',
    });
    this.errorEditor.set(null);
    this.editando.set(proveedor);
    this.editorVisible.set(true);
  }

  cancelar(): void {
    this.editando.set(null);
    this.editorVisible.set(false);
    this.errorEditor.set(null);
  }

  /**
   * El mensaje de un campo, si el backend lo mandó o el formulario lo sabe.
   *
   * El error va DEBAJO del campo y no solo en el aviso de arriba del
   * formulario: lo que hay que corregir es el campo, y un mensaje suelto
   * obliga a buscar cuál de los tres es.
   */
  problemaDe(campo: 'nombre' | 'contacto' | 'telefono'): string | null {
    const control = this.forma.controls[campo];
    if (control.hasError('requerido')) return 'Este campo es obligatorio.';
    if (control.hasError('maxlength')) return 'Es más largo de lo permitido.';
    if (control.hasError('duplicado')) return 'Ya existe un proveedor con este nombre.';
    return null;
  }

  /** Enter guarda el editor, Escape lo cierra. Igual que en el catálogo. */
  onKeydown(evento: KeyboardEvent): void {
    if (evento.key === 'Escape') {
      this.cancelar();
      return;
    }
    if (evento.key === 'Enter' && !this.guardando() && this.forma.valid) {
      evento.preventDefault();
      void this.guardar();
    }
  }

  /**
   * Alta o edición: lo decide `esAlta`. El `activo` no se manda, porque el
   * esquema de crear no lo acepta y la baja se decide desde la fila.
   */
  async guardar(): Promise<void> {
    if (this.guardando() || this.forma.invalid || !this.puedeGuardar()) return;

    this.guardando.set(true);
    this.errorEditor.set(null);
    const cuerpo = cuerpoDeProveedor(this.forma.getRawValue());

    try {
      const actual = this.editando();
      if (actual === null) return;

      if (actual.id === undefined) {
        await this.api.crear(cuerpo);
        this.toast.exito('Proveedor creado con éxito');
      } else {
        await this.api.actualizar(actual.id, cuerpo);
        this.toast.exito('Proveedor guardado con éxito');
      }

      this.editando.set(null);
      this.editorVisible.set(false);
      await this.recargar();
    } catch (falla) {
      const legible = errorLegible(falla);
      // El nombre repetido se marca en el campo, no solo en el aviso de
      // arriba: el operador tiene que saber QUÉ campo corregir.
      if (legible.codigo === 'PROVEEDOR_DUPLICADO') {
        this.forma.controls.nombre.setErrors({ duplicado: true });
      }
      this.errorEditor.set(legible.mensaje);
      this.toast.error(legible.mensaje);
    } finally {
      this.guardando.set(false);
    }
  }

  /**
   * Da de baja o reactiva desde la fila, sin abrir el editor.
   *
   * No pregunta nada, y no por descuido: no se borra nada y el historial del
   * proveedor (sus compras) sigue ahí. Lo que se pierde es la posibilidad de
   * elegirlo en una compra nueva, y eso se deshace con el mismo botón.
   *
   * Al recargar, la fila puede desaparecer del listado —si el filtro es
   * "activos", al dar de baja no sale— y por eso se vuelve a pedir la misma
   * página: la que se pide puede haber dejado de existir y `cargarPagina`
   * retrocede sola.
   */
  async alternarActivo(proveedor: ProveedorListado): Promise<void> {
    if (this.guardando()) return;

    this.guardando.set(true);
    this.error.set(null);
    try {
      await this.api.alternarActivo(proveedor.id, !proveedor.activo);
      this.toast.exito(proveedor.activo ? 'Proveedor dado de baja' : 'Proveedor activado');
      await this.cargarPagina(this.pagina());
    } catch (falla) {
      const legible = errorLegible(falla);
      this.error.set(legible.mensaje);
      this.toast.error(legible.mensaje);
    } finally {
      this.guardando.set(false);
    }
  }
}
