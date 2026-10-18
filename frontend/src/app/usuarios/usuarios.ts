import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
  viewChild,
  type ElementRef,
} from '@angular/core';
import {
  FormBuilder,
  ReactiveFormsModule,
  Validators,
  type AbstractControl,
  type ValidationErrors,
} from '@angular/forms';
import { errorLegible } from '../nucleo/api';
import { filasAnimation, Recarga } from '../nucleo/animaciones';
import {
  guardarFondo,
  guardarFondoPropio,
  leerFondoPropio,
  quitarFondoPropio,
} from '../nucleo/fondo-login';
import { Sesion } from '../nucleo/sesion';
import { ToastService } from '../nucleo/toast.service';
import { ConfirmModal } from '../productos/confirm-modal';
import {
  ETIQUETA_ESTADO,
  UsuariosApi,
  cuerpoDeActualizacion,
  cuerpoDeUsuario,
  estadoDeCuenta,
  motivoDeCandado,
  nombreCompleto,
  rolesEnLinea,
  rolesNormalizados,
  rfcNormalizado,
  rfcValido,
  type FondoLogin,
  type Rol,
  type Usuario,
} from './usuarios-api';

/**
 * La pantalla de usuarios, roles y clave.
 *
 * Es la del negocio con más de esas cosas que el sistema impide y la pantalla
 * tiene que traducir ("no puedes desactivar tu propia cuenta"), y por eso la
 * lógica está en `usuarios-api.ts` y no aquí. Lo que queda en el componente
 * es la navegación entre las tres vistas y el pegado de errores.
 *
 * Las tres vistas:
 *
 *   - **Lista.** Búsqueda, filtro por rol, filtro de estado y paginación de
 *     verdad, igual que proveedores. Sale solo la gente activa, como en
 *     proveedores.
 *   - **Editor.** El mismo formulario para el alta y para la edición, y la
 *     diferencia real está en que al editar el RFC y el correo NO se pueden
 *     tocar: al actualizar no se aceptan y no es una limitación de la
 *     pantalla. Se muestran de todos modos, en solo lectura, para que quien
 *     edita vea el RFC que tiene la persona enfrente. En el alta además
 *     salen la clave y su confirmación, ambas OPCIONALES: en blanco el
 *     sistema genera la temporal de siempre, y escrita la usa tal cual y la
 *     persona nace sin pendiente de cambio.
 *   - **Detalle.** La ficha con los datos que no se editan (intentos
 *     fallidos, bloqueado hasta, último acceso), los roles como casillas y
 *     las tres acciones: activar/desactivar, cambiar roles y resetear clave.
 *
 * Lo de las acciones que se olvidan en un clic:
 *
 *   - **La clave temporal se muestra una vez y hay que copiarla.** Vuelve en
 *     el alta (solo si el administrador dejó la clave en blanco) y en el
 *     reseteo, y en la base solo queda la clave cifrada. Por eso hay un
 *     panel con el texto seleccionable y un botón de copiar, y no un aviso
 *     que se va solo: si el operador lo pierde, tiene que volver a resetear,
 *     y ahí ya no sabe si el anterior sirvió.
 *   - **Cambiar roles saca a la persona de todos los equipos.** El sistema
 *     cierra sus sesiones (`roles_actualizados`), así que hay que avisar
 *     antes de confirmar, no después.
 *   - **Los errores de candado van donde se cometió.** `NO_SELF_DESACTIVAR`
 *     se pinta junto al botón de desactivar y los de duplicado junto al
 *     campo, como el nombre en proveedores.
 */

type Vista = 'lista' | 'editor' | 'detalle';

/**
 * El RFC se valida con la MISMA expresión del sistema, mientras se escribe.
 *
 * Va como `pattern` del control y no solo al enviar porque `Validators`
 * comprueba el valor en cuanto se toca el campo: con 13 caracteres la
 * persona ya está escribiendo el último, y un error que aparece al salir
 * obliga a corregir medio campo. Y `null` (no `{rfc: false}`) cuando está
 * vacío, porque de eso se encarga `required` y un campo no puede tener dos
 * errores a la vez.
 */
function validaRfc(control: { value: string }): Record<string, boolean> | null {
  const valor = control.value.trim();
  if (valor === '') return null;
  return rfcValido(valor) ? null : { rfc: true };
}

/**
 * Las tres clases de la política del sistema (`contrasenaFuerte`): 12+
 * caracteres, mayúscula, minúscula y un número.
 *
 * Va aquí para que el error salga pegado al campo en vez de después del
 * viaje al sistema, pero quien MANDA es el sistema: si las dos reglas se
 * llegan a separar, gana la del sistema y el alta falla ahí. En vacío pasa
 * sin más, porque la clave es opcional en el alta (`Validators.minLength`
 * también se salta lo vacío, que para eso está).
 */
function validaClaseDeClave(control: { value: string }): ValidationErrors | null {
  const valor = String(control.value);
  if (valor === '') return null;
  const cumple = /[a-z]/.test(valor) && /[A-Z]/.test(valor) && /\d/.test(valor);
  return cumple ? null : { contrasenaDebil: true };
}

/**
 * Que las dos claves del alta dicen lo mismo.
 *
 * La comparación vive en el GRUPO y no en `confirmar`: un control solo se
 * ve a sí mismo, y para comparar tiene que alcanzar a su hermano. Con las
 * dos vacías no hay error —la clave es opcional—; lo que no puede pasar es
 * que una se escriba y la otra no, o que difieran.
 */
function clavesCoinciden(grupo: AbstractControl): ValidationErrors | null {
  const clave = String(grupo.get('contrasena')?.value ?? '');
  const otra = String(grupo.get('confirmar')?.value ?? '');
  if (clave === '' && otra === '') return null;
  return clave === otra ? null : { noCoinciden: true };
}

/** Lo que se guarda de una clave recién generada, para mostrarla. */
export interface ClaveMostrada {
  contrasena: string;
  /** Para el título: "Clave de Juan Pérez" o "Contraseña reseteada". */
  titulo: string;
  /** Cuántas sesiones quedaron cerradas, si el dato viene. */
  sesionesCerradas: number | null;
}

@Component({
  selector: 'app-usuarios',
  templateUrl: './usuarios.html',
  styleUrl: './usuarios.scss',
  imports: [ReactiveFormsModule, ConfirmModal],
  changeDetection: ChangeDetectionStrategy.OnPush,
  animations: [filasAnimation],
})
export class Usuarios {
  private readonly api = inject(UsuariosApi);
  private readonly fb = inject(FormBuilder);
  private readonly sesion = inject(Sesion);
  private readonly toast = inject(ToastService);

  // ------------------------------------------------------------- el listado
  /** Para la cascada de entrada de la tabla. Ver `nucleo/animaciones.ts`. */
  readonly recarga = new Recarga();

  readonly vista = signal<Vista>('lista');
  readonly filas = signal<Usuario[]>([]);
  readonly total = signal(0);
  readonly buscando = signal(false);
  readonly error = signal<string | null>(null);
  readonly buscador = signal('');
  readonly filtroRol = signal<number | null>(null);
  readonly filtroActivo = signal<'todos' | 'activos' | 'inactivos'>('activos');

  /**
   * Cuántas personas se ven por página, y la página que se está viendo.
   *
   * La página se elige en SALTOS y se traduce a la posición al pedir, porque
   * una posición guardada se queda vieja en cuanto cambia un filtro.
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
   * Si el listado lleva algo puesto, para poder ofrecer "Quitar filtros".
   *
   * El buscador se cuenta con dos caracteres porque es lo que el sistema
   * exige: con uno solo no filtra, y un botón que aparece a la primera letra
   * confunde más de lo que ayuda.
   */
  readonly hayFiltros = computed(
    () =>
      this.buscador().trim().length >= 2 ||
      this.filtroRol() !== null ||
      this.filtroActivo() !== 'activos',
  );

  /**
   * El catálogo de roles, para el filtro de la lista y para las casillas.
   *
   * Son cinco filas fijas: se piden una vez y se quedan en memoria. Se pide
   * en el constructor porque tanto el filtro como el editor las necesitan, y
   * sin el catálogo el filtro de rol no se puede dibujar.
   */
  readonly catalogo = signal<Rol[]>([]);

  /**
   * Los fondos de login, para el selector del editor.
   *
   * Se piden al sistema y no se escriben aquí: la lista crece con una
   * actualización del sistema, y una copia en la pantalla se desincronizaría
   * en silencio. Con dos imágenes da igual, pero la próxima que se agregue
   * solo se pondría visible editando dos archivos.
   */
  readonly fondos = signal<FondoLogin[]>([]);

  /**
   * El fondo elegido en el editor, o null para el de por defecto.
   *
   * Va aparte del formulario a propósito: `fondo_login` es opcional al
   * actualizar, y si fuera un control del form, guardar sin tocarlo mandaría
   * el valor inicial y dejaría fijada una elección que nadie hizo.
   */
  readonly fondoElegido = signal<string | null>(null);

  /**
   * La imagen propia del LOGIN de ESTE navegador, o `null` si no hay ninguna.
   *
   * Vive fuera del sistema (localStorage): es una imagen que la persona
   * eligió de su equipo y que no se copia al proyecto. Por eso el estado se
   * lee una vez al entrar y no se guarda con la cuenta (ver los helpers de
   * `nucleo/fondo-login.ts`).
   */
  readonly fondoPropio = signal<string | null>(leerFondoPropio());
  readonly errorImagen = signal<string | null>(null);
  readonly selectorImagen = viewChild.required<ElementRef<HTMLInputElement>>('selectorImagen');

  /**
   * El diálogo de confirmación, para las bajas que se hacen con un clic.
   *
   * Es el mismo `ConfirmModal` que usan catálogo, clientes o notas: la
   * confirmación de una acción que no tiene vuelta va en un cuadro centrado y
   * con su texto, no en un aviso que se va solo.
   */
  readonly confirmModal = viewChild.required(ConfirmModal);

  // ---------------------------------------------------------------- el editor
  readonly editando = signal<Usuario | null>(null);
  readonly guardando = signal(false);
  readonly errorEditor = signal<string | null>(null);
  /** Los roles marcados en las casillas del editor. */
  readonly rolesMarcados = signal<number[]>([]);

  readonly editorAbierto = computed(() => this.editando() !== null);
  /** Sin id es el alta (ver `nuevo`). */
  readonly esAlta = computed(() => this.editando()?.id === undefined);
  /** Al editar, el RFC y el correo no se tocan. */
  readonly rfcBloqueado = computed(() => !this.esAlta());
  /** El alta exige al menos un rol (`crearUsuarioEsquema`). */
  readonly faltaUnRol = computed(() => this.esAlta() && this.rolesMarcados().length === 0);

  // --------------------------------------------------------------- el detalle
  readonly abierto = signal<Usuario | null>(null);
  readonly cargandoDetalle = signal(false);
  /** El error de una acción puntual (desactivar, roles, reseteo). */
  readonly errorAccion = signal<string | null>(null);

  // ------------------------------------------------------------ los permisos
  readonly puedeCrear = computed(() => this.sesion.puede('usuarios.crear'));
  readonly puedeEditar = computed(() => this.sesion.puede('usuarios.editar'));

  /** El id de quien está en la pantalla, para los candados. */
  private readonly idActual = computed(() => this.sesion.perfil()?.id ?? -1);

  // ----------------------------------------------------------------- la clave
  /** El panel de clave temporal, o `null` si no hay ninguna que mostrar. */
  readonly clave = signal<ClaveMostrada | null>(null);
  readonly copiada = signal(false);
  readonly errorClave = signal<string | null>(null);

  // ---------------------------------------------------------- el eliminar
  /**
   * La cuenta que se está por eliminar, o `null` si el diálogo está cerrado.
   *
   * El diálogo tiene dos pasos porque el código lo tiene el empleado, no el
   * administrador: primero se pide (el sistema lo manda al correo de la
   * persona) y después se teclea el que la persona dictó.
   */
  readonly eliminando = signal<Usuario | null>(null);
  readonly pasoEliminar = signal<'pedir' | 'codigo'>('pedir');
  readonly codigoEliminar = signal('');
  /** A dónde se mandó el código, para decirlo en el segundo paso. */
  readonly correoCodigo = signal<string | null>(null);
  readonly errorEliminar = signal<string | null>(null);
  readonly enviandoCodigo = signal(false);
  readonly eliminandoEnCurso = signal(false);

  readonly forma = this.fb.nonNullable.group(
    {
      nombre: ['', [Validators.required, Validators.maxLength(120)]],
      apellido_paterno: ['', [Validators.required, Validators.maxLength(120)]],
      apellido_materno: ['', [Validators.maxLength(120)]],
      rfc: ['', [Validators.required, Validators.maxLength(13), validaRfc]],
      email: ['', [Validators.maxLength(200)]],
      puesto: ['', [Validators.maxLength(120)]],
      fecha_contratacion: ['', [Validators.maxLength(10)]],
      // Los dos existen también en la edición (un `setValue` exige las llaves
      // completas), pero se VEN solo en el alta: ahí son opcionales, y la
      // validación de que coincidan es del grupo, no de un campo.
      contrasena: ['', [Validators.minLength(12), Validators.maxLength(200), validaClaseDeClave]],
      confirmar: ['', [Validators.maxLength(200)]],
    },
    { validators: clavesCoinciden },
  );

  // Para la plantilla: son funciones puras y así se leen ahí sin this.
  nombreCompleto = nombreCompleto;
  rolesEnLinea = rolesEnLinea;
  estadoDeCuenta = estadoDeCuenta;
  ETIQUETA_ESTADO = ETIQUETA_ESTADO;
  rfcNormalizado = rfcNormalizado;

  /**
   * La fecha que llega del sistema, sin la `T` ni los milisegundos.
   *
   * Viene en ISO con hora (`2020-01-01T00:00:00.000Z`) y la pantalla solo
   * quiere el día, o el día y la hora cuando lo que se muestra es un
   * instante (el último acceso, el fin del bloqueo). Se corta con `slice` y
   * no con `Date` a propósito: `new Date(...)` corre a la zona horaria del
   * navegador y un alta del día 1 se ve como el día 31 en un huso negativo.
   */
  fechaDe(iso: string, conHora = false): string {
    return conHora ? iso.slice(0, 16).replace('T', ' ') : iso.slice(0, 10);
  }

  constructor() {
    void this.cargarCatalogo();
    void this.cargarFondos();
    void this.recargar();
  }

  private async cargarCatalogo(): Promise<void> {
    try {
      this.catalogo.set(await this.api.roles());
    } catch (falla) {
      this.error.set(errorLegible(falla).mensaje);
    }
  }

  private async cargarFondos(): Promise<void> {
    try {
      this.fondos.set(await this.api.fondos());
    } catch (falla) {
      // A diferencia del catálogo de roles, aquí no hay error: el fondo es
      // decorativo y sin la lista el resto de la pantalla funciona igual. Se
      // avisa igual, pero en consola, para no dejar al usuario con un error
      // en la cara por una foto de fondo.
      console.warn('No se pudieron cargar los fondos del login:', errorLegible(falla).mensaje);
    }
  }

  // ------------------------------------------------------------- el listado

  private temporizador: ReturnType<typeof setTimeout> | undefined;

  /**
   * Busca con 250 ms de espera, igual que el resto de las pantallas.
   *
   * Cada tecleo NO pega una consulta: con el buscador abierto a media
   * escritura son varias y la última es la única que sirve. Además, buscar
   * siempre vuelve a la página 1, porque quedarse en la 4 con un filtro
   * nuevo es mirar una posición que ya no quiere decir nada.
   */
  buscar(texto: string): void {
    clearTimeout(this.temporizador);
    this.buscador.set(texto);
    this.temporizador = setTimeout(() => void this.recargar(), 250);
  }

  /** Cambia el filtro de rol. También vuelve a la primera página. */
  filtrarRol(id: string): void {
    const numero = Number(id);
    this.filtroRol.set(id === '' || Number.isNaN(numero) ? null : numero);
    void this.recargar();
  }

  /** Cambia el filtro de estado. También vuelve a la primera página. */
  filtrarActivo(activo: string): void {
    this.filtroActivo.set(activo as 'todos' | 'activos' | 'inactivos');
    void this.recargar();
  }

  /** Deja el buscador y los filtros como estaban al entrar. */
  limpiarFiltros(): void {
    clearTimeout(this.temporizador);
    this.buscador.set('');
    this.filtroRol.set(null);
    this.filtroActivo.set('activos');
    void this.recargar();
  }

  /** Vuelve a la primera página con el filtro que se tenga puesto. */
  private async recargar(): Promise<void> {
    await this.cargarPagina(1);
  }

  /** Carga una página. Es la ÚNICA forma de pedir usuarios. */
  private async cargarPagina(pagina: number): Promise<void> {
    this.buscando.set(true);
    this.error.set(null);
    try {
      const resultado = await this.api.listar({
        buscar: this.textoBusqueda(),
        rol: this.filtroRol(),
        activo: this.filtroActivo(),
        limite: this.limite(),
        offset: (pagina - 1) * this.limite(),
      });

      // Se dio de baja la última persona de la última página: la que se pide
      // ya no existe. Se retrocede una en vez de dejar una tabla vacía con el
      // contador diciendo "página 7 de 7".
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
    document.querySelector('app-usuarios .tabla-wrapper')?.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    });
  }

  /** El tamaño de página como texto, para el `[value]` del desplegable. */
  limiteComoTexto(): string {
    return String(this.limite());
  }

  /** Cambia cuántas personas se ven por página. */
  aTamanoDePagina(valor: string): void {
    const limite = Number(valor);
    if (!Number.isFinite(limite) || limite <= 0 || limite === this.limite()) return;

    this.limite.set(limite);
    // Vuelve SIEMPRE a la página 1: quedarse en la 7 y pasar de 25 a 50
    // filas es pedir una posición que ya no corresponde a nada.
    void this.recargar();
  }

  /**
   * El texto de búsqueda, o `undefined` si es muy corto.
   *
   * El mínimo de DOS caracteres es el mismo de las otras pantallas: con uno
   * solo la búsqueda por parecido del sistema (`usuarios/repositorio.ts`)
   * trae medio directorio y la tabla deja de informar.
   */
  private textoBusqueda(): string | undefined {
    const limpio = this.buscador().trim();
    return limpio.length >= 2 ? limpio : undefined;
  }

  // ---------------------------------------------------------------- el editor

  nuevo(): void {
    this.forma.reset({
      nombre: '',
      apellido_paterno: '',
      apellido_materno: '',
      rfc: '',
      email: '',
      puesto: '',
      fecha_contratacion: '',
      // En blanco: si no se escribe nada, el sistema genera la clave
      // temporal de siempre y la pantalla muestra el panel de una sola vez.
      contrasena: '',
      confirmar: '',
    });
    this.errorEditor.set(null);
    // El rol 2 de una vez, porque es lo que el sistema pone por omisión
    // (`crearUsuarioEsquema` trae `roles: [2].default()`) y es el de
    // mostrador. Se busca por id y no por nombre a propósito: el nombre está
    // en español y con acentos en la base, y porque el id es lo que viaja.
    // Si el catálogo todavía no ha llegado se deja sin marcar y hay que
    // elegirlo, que es lo correcto para dar de alta a alguien.
    const porDefecto = this.catalogo().find((rol) => rol.id === 2);
    this.rolesMarcados.set(porDefecto ? [porDefecto.id] : []);
    // Sin elección en el alta: el fondo por defecto es el del sistema, y
    // dejarlo en null lo dice de forma explícita.
    this.fondoElegido.set(null);
    // Sin id: el editor sabe que es alta (ver `esAlta`).
    this.editando.set({} as Usuario);
  }

  editar(usuario: Usuario): void {
    this.forma.setValue({
      nombre: usuario.nombre,
      apellido_paterno: usuario.apellido_paterno,
      apellido_materno: usuario.apellido_materno ?? '',
      rfc: usuario.rfc,
      email: usuario.email ?? '',
      puesto: usuario.puesto ?? '',
      fecha_contratacion: usuario.fecha_contratacion.slice(0, 10),
      // Al editar no hay clave que poner: al actualizar no se acepta. Se
      // reinician por el `setValue` (pide TODAS las llaves), no porque se
      // vayan a usar.
      contrasena: '',
      confirmar: '',
    });
    // Al editar el fondo SÍ se cambia desde aquí, a diferencia de los roles.
    // Es una preferencia sin efecto sobre las sesiones abiertas, así que no
    // tiene por qué ir en su propia actualización como la de los roles.
    this.fondoElegido.set(usuario.fondo.clave);
    // Los roles NO se marcan aquí a propósito: al editar no se cambian, se
    // cambian desde el detalle con su propia actualización, que además cierra
    // las sesiones de la persona. Poner casillas que no guardan nada sería
    // una trampa.
    this.errorEditor.set(null);
    this.editando.set(usuario);
  }

  /** Elige un fondo del login. Volver a marcar el que ya estaba lo deja igual. */
  elegirFondo(clave: string): void {
    this.fondoElegido.update((actual) => (actual === clave ? null : clave));
  }

  /** Abre el selector de archivos oculto; el input es accesible y funcional. */
  abrirSelectorImagen(): void {
    this.errorImagen.set(null);
    this.selectorImagen().nativeElement.click();
  }

  /**
   * Procesa la imagen elegida de este equipo.
   *
   * Se comprime en `nucleo/fondo-login.ts` y se guarda en el navegador, NO en
   * la cuenta ni en el sistema. El `value = ''` después de leer es para que
   * elegir la MISMA imagen dos veces vuelva a disparar el `(change)`.
   */
  async seleccionarFondoPropio(evento: Event): Promise<void> {
    const input = evento.target as HTMLInputElement;
    const archivo = input.files?.[0];
    if (archivo === undefined) return;

    this.errorImagen.set(null);
    try {
      const imagen = await guardarFondoPropio(archivo);
      this.fondoPropio.set(imagen);
      this.toast.exito('Se actualizó el fondo del login');
    } catch {
      this.errorImagen.set(
        'No se pudo usar esa imagen: elige un jpg, png o webp y vuelve a intentarlo.',
      );
    } finally {
      input.value = '';
    }
  }

  /**
   * Quita la imagen propia del navegador.
   *
   * El login vuelve al fondo de la cuenta que se está viendo (el de `fondo`
   * del usuario en edición, que el navegador ya recordaba), o al de por
   * defecto si no hay cuenta que restaurar.
   */
  quitarFondoPropio(): void {
    const usuario = this.editando();
    if (usuario !== null && usuario.fondo !== undefined) {
      guardarFondo(usuario.fondo.url);
    } else {
      quitarFondoPropio();
    }
    this.fondoPropio.set(null);
    this.toast.exito('Se quitó tu imagen del login');
  }

  /**
   * El fondo por defecto, para el botón de "quitar la elección".
   *
   * Va repetido aquí a propósito y no se pide al sistema: el selector lo
   * dibuja al abrirse, y una consulta para saber cuál es el default sería un
   * viaje de más en cada edición por un dato que solo cambia con una
   * actualización del sistema. Si se cambia el default hay que tocar este
   * renglón, `FONDO_POR_DEFECTO` de `nucleo/fondo-login.ts` y
   * `FONDO_LOGIN_DEFECTO` del sistema.
   */
  readonly claveFondoDefecto = 'establo';

  cancelar(): void {
    this.editando.set(null);
    this.errorEditor.set(null);
  }

  alternarRol(id: number): void {
    this.rolesMarcados.update((actuales) =>
      actuales.includes(id) ? actuales.filter((rol) => rol !== id) : [...actuales, id],
    );
  }

  /**
   * El RFC, en mayúsculas mientras se escribe.
   *
   * El `maxlength(13)` del input cuenta lo tecleado, así que en minúsculas
   * se ven 13 y en mayúsculas también: lo que cambia es que el valor del
   * campo quede siendo exactamente el que se va a mandar, para que lo que
   * se ve sea lo que el sistema recibe y valida.
   */
  alEscribirRfc(evento: Event): void {
    const input = evento.target as HTMLInputElement;
    this.forma.controls.rfc.setValue(rfcNormalizado(input.value));
  }

  /** El mensaje de un campo, si el sistema lo mandó o el form lo sabe. */
  problemaDe(campo: keyof typeof this.forma.controls): string | null {
    const control = this.forma.controls[campo];
    if (control.hasError('requerido')) return 'Este campo es obligatorio.';
    if (control.hasError('minlength')) return 'La contraseña necesita al menos 12 caracteres.';
    if (control.hasError('contrasenaDebil')) {
      return 'Debe tener mayúsculas, minúsculas y al menos un número.';
    }
    if (control.hasError('maxlength')) return 'Es más largo de lo permitido.';
    if (control.hasError('rfc')) return 'El RFC no cumple el formato del SAT.';
    if (control.hasError('duplicado')) {
      return campo === 'rfc'
        ? 'Ya existe un usuario con este RFC.'
        : 'Ya existe un usuario con ese correo.';
    }
    return null;
  }

  /** Alta o edición: lo decide `esAlta`. */
  async guardar(): Promise<void> {
    if (this.guardando() || this.forma.invalid) return;
    if (this.faltaUnRol()) {
      this.errorEditor.set('Elige al menos un rol para la persona.');
      return;
    }

    this.guardando.set(true);
    this.errorEditor.set(null);
    const bruto = this.forma.getRawValue();

    try {
      const actual = this.editando();
      if (actual === null) return;

      if (actual.id === undefined) {
        // Alta: van los cinco campos del RFC, el correo, la fecha y la
        // clave si el administrador la escribió.
        const respuesta = await this.api.crear(
          cuerpoDeUsuario(bruto, rolesNormalizados(this.rolesMarcados(), this.catalogo())),
        );
        this.editando.set(null);
        await this.recargar();
        // La clave temporal se muestra UNA vez y va ANTES de la recarga en
        // el orden del código: si la recarga falla, el usuario ya existe en
        // la base y sin esta clave no hay forma de que vuelva a entrar. Si
        // no viene (el administrador eligió la clave) no hay panel: ya la
        // tiene la persona y volver a mostrársela sería una copia de algo
        // que ya no es secreto para nadie.
        if (respuesta.contrasenaTemporal !== null) {
          this.mostrarClave({
            contrasena: respuesta.contrasenaTemporal,
            titulo: `Clave de ${nombreCompleto(respuesta.usuario)}`,
            sesionesCerradas: null,
          });
        }
      } else {
        // Edición: los roles NO se tocan aquí. Van en su propia
        // actualización, que cierra las sesiones, y mezclarlos haría que un
        // cambio de nombre tumbara a la persona de todos los equipos.
        const actualizado = await this.api.actualizar(actual.id, {
          ...cuerpoDeActualizacion(bruto),
          fondo_login: this.fondoElegido(),
        });
        // Si la persona editada es la de esta máquina, su copia local del
        // login se actualiza también. Sin esto habría que esperar al próximo
        // ingreso para que el fondo nuevo se viera, y parecería que el cambio
        // no se guardó. Con una imagen propia de este equipo puesta, ESA gana:
        // es una elección local y quitarle el lugar a cada guardado sería
        // perderla a la primera edición.
        if (actualizado.id === this.idActual() && this.fondoPropio() === null) {
          guardarFondo(actualizado.fondo.url);
        }
        this.editando.set(null);
        await this.recargar();
        // Si se abrió desde la ficha, la ficha se queda abierta y se
        // refresca: cancelar y guardar devuelven a la misma pantalla.
        const abierto = this.abierto();
        if (this.vista() === 'detalle' && abierto !== null && abierto.id === actual.id) {
          this.abierto.set(await this.api.obtener(actual.id));
        }
      }
    } catch (falla) {
      const legible = errorLegible(falla);
      if (legible.codigo === 'RFC_DUPLICADO') {
        this.forma.controls.rfc.setErrors({ duplicado: true });
      }
      if (legible.codigo === 'EMAIL_DUPLICADO') {
        this.forma.controls.email.setErrors({ duplicado: true });
      }
      this.errorEditor.set(legible.mensaje);
    } finally {
      this.guardando.set(false);
    }
  }

  // --------------------------------------------------------------- el detalle

  async ver(usuario: Usuario): Promise<void> {
    this.abierto.set(usuario);
    this.errorAccion.set(null);
    this.vista.set('detalle');
    this.cargandoDetalle.set(true);
    try {
      // Se vuelve a pedir: la fila de la lista puede tener la foto de hace
      // un rato y lo que se muestra aquí son los intentos fallidos y el
      // bloqueo, que cambian sin que la lista lo note.
      const fresco = await this.api.obtener(usuario.id);
      this.abierto.set(fresco);
      // Las casillas de roles salen de la ficha, no de la fila de la lista:
      // una lista paginada puede no tener a esta persona, y si las casillas
      // arrancaran vacías el primer guardado sería una actualización con cero
      // roles.
      this.rolesMarcados.set(fresco.roles.map((rol) => rol.id));
    } catch (falla) {
      this.errorAccion.set(errorLegible(falla).mensaje);
    } finally {
      this.cargandoDetalle.set(false);
    }
  }

  refrescarDetalle(): void {
    const abierto = this.abierto();
    if (abierto) void this.ver(abierto);
  }

  volverALista(): void {
    this.vista.set('lista');
    this.abierto.set(null);
    this.errorAccion.set(null);
  }

  /** El botón de activar/desactivar, con su candado puesto si toca. */
  motivoDeDesactivar(usuario: Usuario): string | null {
    return motivoDeCandado('desactivar', usuario, this.idActual(), true);
  }

  /**
   * Por qué no se puede eliminar todavía, o `null` si se puede.
   *
   * Los tres casos son datos que la ficha ya trae, así que el botón se apaga
   * con su motivo en vez de mandar la petición para que el sistema conteste.
   */
  motivoDeEliminar(usuario: Usuario): string | null {
    return motivoDeCandado('eliminar', usuario, this.idActual(), true);
  }

  /**
   * Da de baja o reactiva.
   *
   * Se actualiza un solo campo. Desactivar a alguien cierra sus sesiones en
   * el sistema, así que se confirma antes: no es un cambio reversible en el
   * acto, es "se cae del sistema ahora". Reactivar no se pregunta: no rompe
   * nada y el error, si lo hay, lo dice el sistema.
   */
  async alternarActivo(): Promise<void> {
    const usuario = this.abierto();
    if (usuario === null || this.guardando()) return;
    if (motivoDeCandado('desactivar', usuario, this.idActual(), true) !== null) return;

    if (usuario.activo) {
      const confirmado = await this.confirmModal().abrir({
        titulo: 'Desactivar la cuenta',
        mensaje: `${nombreCompleto(usuario)} dejará de poder entrar y se cerrarán sus sesiones abiertas en todos los equipos.`,
        textoConfirmar: 'Desactivar',
        variante: 'advertencia',
      });
      if (!confirmado) return;
    }

    this.guardando.set(true);
    this.errorAccion.set(null);
    try {
      const actualizado = await this.api.actualizar(usuario.id, { activo: !usuario.activo });
      this.abierto.set(actualizado);
      // La fila puede desaparecer del listado —con el filtro en "activos",
      // al dar de baja no sale— y por eso se vuelve a pedir la MISMA página:
      // si dejó de existir, `cargarPagina` retrocede sola.
      await this.cargarPagina(this.pagina());
    } catch (falla) {
      // `ULTIMO_ADMIN` llega aquí: no se sabe desde la pantalla si es el
      // único, y el mensaje del sistema ya lo dice.
      this.errorAccion.set(errorLegible(falla).mensaje);
    } finally {
      this.guardando.set(false);
    }
  }

  /**
   * Cambia los roles.
   *
   * La actualización reemplaza la lista completa, así que lo que se manda es
   * lo marcado y nada más. Cierra las sesiones de la persona (el sistema las
   * cierra con `roles_actualizados`), y por eso la interfaz avisa antes de
   * guardar en vez de dejar que se entere al aplicarlo.
   */
  async guardarRoles(): Promise<void> {
    const usuario = this.abierto();
    if (usuario === null || this.guardando()) return;
    const roles = rolesNormalizados(this.rolesMarcados(), this.catalogo());
    if (roles.length === 0) {
      this.errorAccion.set('El usuario necesita al menos un rol.');
      return;
    }

    this.guardando.set(true);
    this.errorAccion.set(null);
    try {
      this.abierto.set(await this.api.asignarRoles(usuario.id, roles));
      this.rolesMarcados.set(roles);
      await this.cargarPagina(this.pagina());
    } catch (falla) {
      this.errorAccion.set(errorLegible(falla).mensaje);
    } finally {
      this.guardando.set(false);
    }
  }

  /** El candado de quitar el admin, o `null` si el cambio se puede hacer. */
  motivoDeQuitarAdmin(): string | null {
    const usuario = this.abierto();
    if (usuario === null) return null;
    const dejaAdmin = this.rolesMarcados().some(
      (id) => this.catalogo().find((rol) => rol.id === id)?.es_admin === true,
    );
    return motivoDeCandado('quitar_admin', usuario, this.idActual(), dejaAdmin);
  }

  /**
   * Resetea la clave.
   *
   * No se pide nada: la genera el sistema y vuelve una sola vez. Por eso
   * después hay un panel con el texto, y no un aviso en la esquina.
   */
  async resetearContrasena(): Promise<void> {
    const usuario = this.abierto();
    if (usuario === null || this.guardando()) return;

    this.guardando.set(true);
    this.errorAccion.set(null);
    this.errorClave.set(null);
    try {
      const respuesta = await this.api.resetearContrasena(usuario.id);
      this.mostrarClave({
        contrasena: respuesta.contrasenaTemporal,
        titulo: `Contraseña nueva de ${nombreCompleto(usuario)}`,
        sesionesCerradas: respuesta.sesionesCerradas,
      });
      // La cuenta queda marcada para cambiar la clave en su próximo ingreso,
      // así que la ficha se refresca para que se vea.
      this.refrescarDetalle();
    } catch (falla) {
      this.errorClave.set(errorLegible(falla).mensaje);
    } finally {
      this.guardando.set(false);
    }
  }

  // --------------------------------------------------------------- el eliminar

  /**
   * Abre el diálogo de eliminación de la cuenta abierta.
   *
   * Solo se llega aquí con una cuenta ya desactivada: el botón está apagado
   * mientras siga activa (ver `motivoDeEliminar`), y el sistema lo vuelve a
   * comprobar. El primer paso es pedir el código.
   */
  abrirEliminar(): void {
    const usuario = this.abierto();
    if (usuario === null) return;
    this.pasoEliminar.set('pedir');
    this.codigoEliminar.set('');
    this.correoCodigo.set(null);
    this.errorEliminar.set(null);
    this.eliminando.set(usuario);
  }

  cerrarEliminar(): void {
    if (this.eliminandoEnCurso()) return;
    this.eliminando.set(null);
    this.errorEliminar.set(null);
    this.codigoEliminar.set('');
  }

  /**
   * Manda el código al correo del empleado y pasa al paso de teclearlo.
   *
   * El código NO se muestra en la pantalla: quien lo recibe es la persona, y
   * el administrador tiene que pedírselo. Si el correo no sale, el sistema
   * responde con el error y aquí se pinta.
   */
  async solicitarCodigo(): Promise<void> {
    const usuario = this.eliminando();
    if (usuario === null || this.enviandoCodigo()) return;

    this.enviandoCodigo.set(true);
    this.errorEliminar.set(null);
    try {
      const respuesta = await this.api.solicitarEliminacion(usuario.id);
      this.correoCodigo.set(respuesta.correo);
      this.pasoEliminar.set('codigo');
    } catch (falla) {
      this.errorEliminar.set(errorLegible(falla).mensaje);
    } finally {
      this.enviandoCodigo.set(false);
    }
  }

  /**
   * Cierra la eliminación con el código que dictó el empleado.
   *
   * Al terminar se vuelve a la lista: la ficha ya no tiene a quién mostrar. El
   * `recargar` va después de cerrar el diálogo para que la fila desaparezca del
   * listado y no se quede un renglón fantasma.
   */
  async confirmarEliminar(): Promise<void> {
    const usuario = this.eliminando();
    if (usuario === null || this.eliminandoEnCurso()) return;

    const codigo = this.codigoEliminar().trim();
    if (codigo === '') {
      this.errorEliminar.set('Escribe el código que te dictó la persona.');
      return;
    }

    this.eliminandoEnCurso.set(true);
    this.errorEliminar.set(null);
    try {
      await this.api.eliminar(usuario.id, codigo);
      this.eliminando.set(null);
      this.toast.exito(`Se eliminó la cuenta de ${nombreCompleto(usuario)}`);
      this.volverALista();
      await this.recargar();
    } catch (falla) {
      this.errorEliminar.set(errorLegible(falla).mensaje);
    } finally {
      this.eliminandoEnCurso.set(false);
    }
  }

  /** El código, mientras se teclea: solo dígitos y hasta seis. */
  alEscribirCodigo(valor: string): void {
    this.codigoEliminar.set(valor.replace(/\D/g, '').slice(0, 6));
  }

  // ----------------------------------------------------------------- la clave

  private mostrarClave(clave: ClaveMostrada): void {
    this.copiada.set(false);
    this.clave.set(clave);
  }

  /**
   * Copia la clave al portapapeles.
   *
   * `navigator.clipboard` necesita un contexto seguro (https o localhost), y
   * se usa desde la red de una tienda, donde no lo hay. Por eso el botón va
   * con la excepción adentro: si falla, el texto sigue seleccionable a mano
   * y el panel dice que se puede escoger.
   */
  async copiarClave(): Promise<void> {
    const clave = this.clave();
    if (clave === null) return;
    try {
      await navigator.clipboard.writeText(clave.contrasena);
      this.copiada.set(true);
    } catch {
      this.copiada.set(false);
    }
  }

  cerrarClave(): void {
    this.clave.set(null);
    this.copiada.set(false);
  }
}
