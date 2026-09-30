import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { errorLegible } from '../nucleo/api';
import { Sesion } from '../nucleo/sesion';
import { bultosComoTexto, kilosComoTexto, montoComoTexto } from '../nucleo/cifras';
import { DireccionesApi, type DireccionEntrega } from './direcciones-api';
import {
  agregar,
  cambiarCantidad,
  cambiarKilos,
  conPrecio,
  kilosDeLinea,
  kilosDeLineas,
  lineaDeRenglon,
  lineaVacia,
  montoDeLinea,
  origenComoTexto,
  problemasDe,
  quitar,
  totalDeLineas,
  vaciar,
  type Linea,
} from './linea';
import {
  NotasApi,
  cuerpoDeEdicion,
  cuerpoDeNota,
  type Cliente,
  type EstatusNota,
  type Nota,
  type NotaListada,
  type Periodo,
  type Producto,
} from './notas-api';

/**
 * El mostrador: capturar una nota de remision y ver las que ya se guardaron.
 *
 * La pantalla son DOS cosas en una sola vista, sin paginas entre ellas:
 *
 *   1. ARRIBA, la captura: cliente, producto, renglones, direccion. Es lo
 *      mismo de siempre: en un mostrador el operador esta parado con el
 *      cliente enfrente y la mercancia en el piso, y cada paso que implique
 *      un "siguiente" es un paso que se equivoca.
 *   2. ABAJO, la tabla de las notas guardadas, con las acciones de cada una:
 *      ver, PDF, Excel, devolucion y cancelacion.
 *
 * Por que la tabla esta en la MISMA pantalla y no en otra: guardar una nota
 * no es el final de la pantalla. En un mostrador se emiten veinte notas en
 * una hora y la mayoria son para el mismo cliente, asi que lo que hace falta
 * despues de guardar es volver a capturar (la siguiente) y de vez en cuando
 * volver a imprimir o corregir una de las anteriores. Con la tabla abajo, las
 * dos cosas estan a un scroll; con un comprobante de pantalla completa
 *   (como estaba antes), imprimir obligaba a salir del mostrador y la tabla
 *   obligaba a cambiar de ruta.
 *
 * Y por que la devolucion es `editar` y no una pantalla aparte: devolver es
 * bajar bultos o quitar renglones de una nota que ya se emitio, y eso es
 * exactamente lo que hace `PATCH /:id` con el inventario del lado correcto
 * (el trigger borra el movimiento de salida y los bultos vuelven a la bodega).
 * No hay tabla de devoluciones en la base ni la va a haber: una devolucion
 * que no se registra como edicion de la nota es un documento que dice que se
 * llevo mas producto del que se llevo.
 *
 * Decisiones que no son obvias:
 *
 *   - El precio se PIDE al backend por producto (`/precios/efectivo`) y no
 *     se manda en el alta. Ver `cuerpoDeNota`, que explica el por que: la
 *     precedencia del precio del cliente sobre el de lista es del backend y
 *     el POS no la reimplementa.
 *   - El total que se ve mientras se captura es un preview de double, y al
 *     guardar se sustituye por el `subtotal` de la base. Ver `totalDeLineas`.
 *   - Los campos de cantidad y kilos se confirman con `change` (al salir o
 *     con Enter) y no con `input`. Con `input` el valor del input se
 *     reescribe en cada tecla y al teclear "0." para escribir "0.5" se
 *     come el punto, porque el modelo ya es 0. Aqui no se pierde nada: se
 *     confirma al salir del campo.
 *   - El periodo del listado lo decide la base, no el reloj del navegador.
 *     Ver `Periodo`.
 */
@Component({
  selector: 'app-notas',
  templateUrl: './notas.html',
  styleUrl: './notas.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Notas {
  private readonly api = inject(NotasApi);
  private readonly apiDirecciones = inject(DireccionesApi);
  private readonly sesion = inject(Sesion);

  // ------------------------------------------------------------- la captura
  readonly cliente = signal<Cliente | null>(null);
  readonly lineas = signal<Linea[]>([]);
  readonly direccion = signal('');

  /**
   * La nota que se esta corrigiendo, o `null` si lo que se esta capturando
   * es una nota nueva.
   *
   * Cuando esta puesta, la pantalla NO es un alta: es una devolucion (o una
   * correccion cualquiera), y lo unico que cambia es el boton grande, que
   * dice "Guardar la devolucion" y llama a `PATCH` en vez de a `POST`.
   *
   * El mismo formulario para las dos cosas, y no dos formularios, porque el
   * renglon que se ve es el mismo: el producto, los bultos, los kilos y el
   * precio. Lo unico que cambia es que al guardar se corrige una nota que ya
   * existe en vez de crear una nueva con el folio siguiente.
   */
  readonly editando = signal<Nota | null>(null);

  /** Resultados de los dos buscadores. */
  readonly resultadosCliente = signal<Cliente[]>([]);
  readonly resultadosProducto = signal<Producto[]>([]);
  readonly buscandoCliente = signal(false);
  readonly buscandoProducto = signal(false);

  /** El renglon al que se le esta preguntando el precio, para no duplicar. */
  readonly preguntando = signal<number | null>(null);

  readonly guardando = signal(false);
  readonly error = signal<string | null>(null);

  /**
   * Lo que se acaba de guardar, para el renglon de aviso de arriba.
   *
   * Antes esto era la pantalla de comprobante: al guardar se tapaba el
   * mostrador con el folio y habia que apretar "otra nota" para seguir. Ahora
   * el formulario queda listo para la siguiente y la nota se ve en la tabla
   * de abajo, asi que lo que se guarda aqui es solo el aviso: que folio
   * salio, cuanto cobro la base (que no es el preview que se estaba viendo)
   * y donde ir a verlo si hace falta.
   */
  readonly ultimaGuardada = signal<Nota | null>(null);

  // --------------------------------------------------------- las direcciones
  /** El catalogo de destinos de la sucursal. Ver `direcciones-api.ts`. */
  readonly direcciones = signal<DireccionEntrega[]>([]);
  /**
   * La direccion del catalogo que esta escrita en el campo.
   *
   * `null` cuando lo que hay escrito es una direccion nueva, todavia no
   * guardada. No se puede deducir del texto: dos destinos puede tener el
   * mismo texto escrito de dos maneras, y de eso se trata.
   */
  readonly direccionElegida = signal<number | null>(null);
  /** El formulario de "guardar esta direccion" / "cambiar esta". */
  readonly formaDireccion = signal<{ id: number | null; nombre: string; direccion: string } | null>(
    null,
  );
  readonly guardandoDireccion = signal(false);
  readonly errorDireccion = signal<string | null>(null);

  // ------------------------------------------------------ la tabla de notas
  readonly notas = signal<NotaListada[]>([]);
  /**
   * Cuantas notas hay en el filtro, no cuantas se ven.
   *
   * El nombre lleva el "notas" porque `total` ya lo ocupa el total de la
   * nota que se esta capturando arriba, que es el que se ve con los miles en
   * el boton. Son dos cifras distintas y en la misma pantalla, asi que
   * nombrarlas distinto no es estetica: es para no tener que leer la pantalla
   * para saber a cual se refiere un `total`.
   */
  readonly totalNotas = signal(0);
  readonly limite = 50;
  readonly cargandoLista = signal(false);
  readonly buscandoMas = signal(false);
  readonly errorLista = signal<string | null>(null);

  /** `'todo'` no se manda: es la ausencia de periodo. Ver `Periodo`. */
  readonly periodo = signal<Periodo | 'todo'>('hoy');
  readonly buscar = signal('');

  /** La nota abierta en la tabla, con sus renglones. `null` es "ninguna". */
  readonly detalle = signal<Nota | null>(null);
  readonly cargandoDetalle = signal(false);

  /** La nota cuya cancelacion esta en captura. `null` es "ninguna". */
  readonly cancelando = signal<NotaListada | null>(null);
  readonly motivo = signal('');
  readonly guardandoCancelacion = signal(false);

  // ------------------------------------------------------------- lo derivado
  readonly total = computed(() => totalDeLineas(this.lineas()));
  readonly kilos = computed(() => kilosDeLineas(this.lineas()));
  readonly hayLineas = computed(() => this.lineas().length > 0);
  readonly hayMas = computed(() => this.notas().length < this.totalNotas());

  /** El texto del boton grande: dice que se esta haciendo, no "guardar". */
  readonly textoGuardar = computed(() => {
    if (this.guardando()) return 'Guardando...';
    return this.editando() === null ? 'Guardar la nota' : 'Guardar la devolucion';
  });

  /** En edicion el precio de la linea ya se cobro: no se vuelve a preguntar. */
  readonly editable = computed(() => {
    const nota = this.editando();
    return nota !== null && (nota.estatus === 'pendiente' || nota.estatus === 'parcial');
  });

  /** La direccion escrita, con la del catalogo si se eligio alguna. */
  readonly direccionDelCatalogo = computed(
    () => this.direcciones().find((otra) => otra.id === this.direccionElegida()) ?? null,
  );

  /**
   * El boton de "guardar esta direccion" se apaga si el texto no alcanza.
   *
   * El minimo de cinco caracteres es el del backend (`textoDireccionEsquema`)
   * y el nombre de dos es el suyo (`nombreDireccionEsquema`). Se repiten aqui
   * por la misma razon que se repiten los problemas de los renglones: para
   * avisar antes, no para substituir al backend.
   */
  readonly direccionGuardable = computed(() => {
    const forma = this.formaDireccion();
    return (
      forma !== null &&
      forma.nombre.trim().length >= 2 &&
      forma.direccion.trim().length >= 5 &&
      !this.guardandoDireccion()
    );
  });

  // ------------------------------------------------------------- el buscador
  private temporizadorCliente: ReturnType<typeof setTimeout> | undefined;
  private temporizadorProducto: ReturnType<typeof setTimeout> | undefined;
  /**
   * El temporizador del buscador de la tabla de abajo.
   *
   * Es un tercero y no el mismo que los otros dos por una razon que se ve al
   * escribirlo: el buscador de la tabla tambien decide CUANDO se pide la
   * pagina, y si compartiera el temporizador con el de productos, teclear en
   * el buscador de la tabla cancelaria una busqueda de producto a media
   * palabra. Son tres Searches distintos y por eso son tres esperas.
   */
  private temporizadorFiltros: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    void this.cargar();
  }

  /**
   * Lo que se carga al abrir la pantalla: las direcciones (que se eligen al
   * capturar) y la tabla de notas (que es lo que hay abajo).
   *
   * Van juntas con `Promise.all` y no en serie porque no dependen una de la
   * otra, y una pantalla de mostrador que tarda lo que las dos mas lo que
   * cada una se siente lenta aunque las dos esten bien.
   */
  private async cargar(): Promise<void> {
    await Promise.all([this.cargarDirecciones(), this.recargar()]);
  }

  /**
   * Se busca con 250 ms de espera.
   *
   * Sin espera, teclear "VIM" hace tres peticiones y las tres respuestas
   * llegan en desorden: la de "VI" se pinta DESPUES de la de "VIM" y la
   * lista muestra productos que no coinciden con lo tecleado. Es el problema
   * clasico de buscar mientras se teclea, y la unica forma de evitarlo sin
   * pedir confirmacion es esperar a que la persona pare.
   */
  buscarCliente(texto: string): void {
    clearTimeout(this.temporizadorCliente);
    const limpio = texto.trim();
    if (limpio.length < 2) {
      this.resultadosCliente.set([]);
      return;
    }
    this.temporizadorCliente = setTimeout(async () => {
      this.buscandoCliente.set(true);
      try {
        this.resultadosCliente.set(await this.api.clientes(limpio));
      } catch {
        // Fallar la busqueda no es motivo para seguir: lo que hay
        // en pantalla sigue valido y el error se vera al guardar. Un fallo
        // del buscador no debe tapar la nota a medio capture.
        this.resultadosCliente.set([]);
      } finally {
        this.buscandoCliente.set(false);
      }
    }, 250);
  }

  buscarProducto(texto: string): void {
    clearTimeout(this.temporizadorProducto);
    const limpio = texto.trim();
    if (limpio.length < 1) {
      this.resultadosProducto.set([]);
      return;
    }
    this.temporizadorProducto = setTimeout(async () => {
      this.buscandoProducto.set(true);
      try {
        this.resultadosProducto.set(await this.api.productos(limpio));
      } catch {
        this.resultadosProducto.set([]);
      } finally {
        this.buscandoProducto.set(false);
      }
    }, 250);
  }

  elegirCliente(cliente: Cliente): void {
    this.cliente.set(cliente);
    this.resultadosCliente.set([]);
    this.error.set(null);
  }

  /** Cambiar de cliente con renglones puestos no se puede: el precio es de el. */
  cambiarCliente(): void {
    if (this.hayLineas() && !confirmar('Si cambias de cliente se borra la nota que llevas.')) {
      return;
    }
    this.cliente.set(null);
    this.lineas.set(vaciar(this.lineas()));
    this.resultadosCliente.set([]);
  }

  /**
   * Agrega un producto a la nota.
   *
   * El precio se pregunta antes de agregar la linea y no despues: si el
   * producto no tiene precio vigente, el backend va a rechazar la nota
   * entera con `SIN_PRECIO` y la persona se entera DESPUES de haber
   * capturado media docena de renglones. Preguntando primero, el error sale
   * cuando todavia no se capturo nada.
   *
   * Y si ya estaba, `agregar` suma la cantidad en vez de duplicar la fila.
   */
  async agregarProducto(producto: Producto): Promise<void> {
    const cliente = this.cliente();
    if (cliente === null) {
      this.error.set('Primero elige el cliente de la nota.');
      return;
    }
    if (this.preguntando() === producto.id) return;

    this.preguntando.set(producto.id);
    this.error.set(null);
    try {
      const precio = await this.api.precio(producto.id, cliente.id);
      if (precio === null) {
        this.error.set(`El producto ${producto.codigo} no tiene precio. Hay que darle de alta.`);
        return;
      }
      if (!precio.vigente || precio.precio_kg === null) {
        this.error.set(
          `El precio del ${producto.codigo} ya vencio (vencia el ${precio.vigente_hasta ?? 'ayer'}). ` +
            'Cámbialo en Precios antes de vender.',
        );
        return;
      }
      this.lineas.update((lineas) => agregar(lineas, conPrecio(lineaVacia(producto), precio)));
      this.resultadosProducto.set([]);
    } catch (falla) {
      this.error.set(errorLegible(falla).mensaje);
    } finally {
      this.preguntando.set(null);
    }
  }

  // ------------------------------------------------------- los renglones
  /** `poner*` y no `cantidad`/`kilos`: `kilos` es la signal del total de la nota. */
  ponerCantidad(uid: number, valor: string): void {
    this.lineas.update((lineas) =>
      lineas.map((linea) => (linea.uid === uid ? cambiarCantidad(linea, valor) : linea)),
    );
  }

  ponerKilos(uid: number, valor: string): void {
    this.lineas.update((lineas) =>
      lineas.map((linea) => (linea.uid === uid ? cambiarKilos(linea, valor) : linea)),
    );
  }

  /**
   * Quita el rengllon de la pantalla.
   *
   * En una devolucion, quitar la fila es DEVOLVER el producto completo: el
   * renglon no vuelve en el cuerpo del `PATCH` y el backend lo borra, y con
   * el movimiento de inventario que lo saco. Bajar la cantidad a un bulto es
   * lo mismo con mejor precision, pero quitar la fila es lo que se usa cuando
   * el producto no se llevo nada.
   */
  quitarLinea(uid: number): void {
    this.lineas.update((lineas) => quitar(lineas, uid));
  }

  // Los simbolos que la plantilla usa como metodo de la clase. Un import
  // suelto no es visible desde el HTML: lo que este en el `import` y no
  // este aqui, la plantilla no lo ve.
  problemasDeLinea = problemasDe;
  kilosDeLinea = kilosDeLinea;
  origenComoTexto = origenComoTexto;
  montoDeLinea = montoDeLinea;
  bultosComoTexto = bultosComoTexto;
  montoComoTexto = montoComoTexto;
  kilosComoTexto = kilosComoTexto;

  // ------------------------------------------------------------- el guardado
  /**
   * Guarda lo que hay en pantalla: una nota nueva, o la correccion de una
   * que ya existe.
   *
   * Los dos caminos salen de aqui y no de dos metodos porque el formulario
   * es uno, y la unica diferencia entre crear y corregir es a quien se le
   * manda el cuerpo (`POST` o `PATCH`). Al terminar los dos hacen lo mismo:
   * dejar la pantalla lista para la siguiente nota, con el cliente puesto, y
   * recargar la tabla de abajo para que la nota (o su nuevo total) se vea sin
   * que la persona tenga que buscarla.
   */
  async guardar(): Promise<void> {
    const cliente = this.cliente();
    const enEdicion = this.editando();
    if (cliente === null || this.guardando()) return;

    this.guardando.set(true);
    this.error.set(null);
    try {
      if (enEdicion === null) {
        const cuerpo = cuerpoDeNota(cliente.id, this.lineas(), this.direccion());
        this.ultimaGuardada.set(await this.api.crear(cuerpo));
      } else {
        const cuerpo = cuerpoDeEdicion(cliente.id, this.lineas(), this.direccion());
        const nota = await this.api.editar(enEdicion.id, cuerpo);
        this.ultimaGuardada.set(nota);
        this.editando.set(null);
        this.lineas.set(vaciar(this.lineas()));
        this.direccionElegida.set(null);
      }
      await this.recargar();
    } catch (falla) {
      this.error.set(this.explicar(falla));
    } finally {
      this.guardando.set(false);
    }
  }

  /**
   * El error de guardar, traducido al idioma de quien esta en el mostrador.
   *
   * `STOCK_INSUFICIENTE` es el que vale la pena tratar: el mensaje del
   * backend ("no hay producto suficiente en el almacen 1") no dice de que
   * producto ni cuanto falta, y el `detalles` si. Como el POS ya sabe el
   * nombre del producto (esta en la linea), el nombre se pone aqui.
   */
  private explicar(falla: unknown): string {
    const legible = errorLegible(falla);
    if (legible.codigo !== 'STOCK_INSUFICIENTE') return legible.mensaje;

    const datos = legible.datos as { producto_id?: number; faltan?: number } | null;
    const linea = this.lineas().find((otra) => otra.producto_id === datos?.producto_id);
    const nombre = linea?.producto_nombre ?? datos?.producto_id ?? 'ese producto';
    const faltan = datos?.faltan;
    return faltan === undefined
      ? legible.mensaje
      : `No hay producto suficiente de ${nombre}: faltan ${kilosComoTexto(faltan)} bultos.`;
  }

  // ------------------------------------------------------------ los permisos
  /**
   * Se puede ABRIR el mostrador con `notas.ver` pero no GUARDAR sin
   * `notas.crear` (`POST /notas-remision` lo pide, ver
   * `notas-remision/rutas.ts`). Un rol que solo consulta llega aqui por el
   * menu y se encuentra con un boton que el backend le va a rechazar con un
   * 403, asi que el boton se apaga y se dice por que.
   *
   * Es la misma ayuda que `sesion.puede` da en todos lados: no es seguridad
   * (el backend lo comprueba igual), es no prometerle a la persona algo que
   * el servidor le va a negar.
   */
  readonly puedeCrear = computed(() => this.sesion.puede('notas.crear'));

  /**
   * Corregir y devolver es `notas.editar`, y cancelar es `notas.cancelar`: no
   * son el mismo permiso y en la tabla salen botones distintos por eso (ver
   * `notas-remision/rutas.ts`). Un rol que solo edita puede devolver mercancia
   * pero no cancelar la nota entera, que es lo que un cajero NO debe poder
   * hacer sin supervision.
   */
  readonly puedeEditar = computed(() => this.sesion.puede('notas.editar'));
  readonly puedeCancelar = computed(() => this.sesion.puede('notas.cancelar'));

  /** PDF y Excel van con `notas.ver`: imprimir no es una operacion distinta. */
  readonly puedeVer = computed(() => this.sesion.puede('notas.ver'));

  readonly puedeVerDirecciones = computed(() => this.sesion.puede('direcciones.ver'));
  readonly puedeGuardarDirecciones = computed(() => this.sesion.puede('direcciones.crear'));
  readonly puedeEditarDirecciones = computed(() => this.sesion.puede('direcciones.editar'));
  readonly puedeBorrarDirecciones = computed(() => this.sesion.puede('direcciones.eliminar'));

  /**
   * El boton grande se apaga con cliente, renglones y lineas sin problemas.
   *
   * El permiso va aqui y no solo en el boton: guardar pide `notas.crear` en
   * el alta y `notas.editar` en la correccion, y el boton es el mismo. Con
   * un rol que solo crea, la pantalla de correccion tiene que quedarse
   * apagada, no la que se enciende y falla con un 403.
   *
   * `editable()` tambien entra, y no por el permiso: es el estatus de la
   * nota. Una pagada o una cancelada no se pueden corregir (los triggers de
   * 0008 lo impiden en la base, no aqui), asi que el boton tiene que estar
   * apagado antes, no despues del error.
   */
  readonly puedeGuardar = computed(
    () =>
      this.cliente() !== null &&
      this.hayLineas() &&
      this.lineas().every((linea) => Object.keys(problemasDe(linea)).length === 0) &&
      this.editable() &&
      (this.editando() === null ? this.puedeCrear() : this.puedeEditar()) &&
      !this.guardando(),
  );

  // -------------------------------------------------------- las direcciones
  private async cargarDirecciones(): Promise<void> {
    try {
      this.direcciones.set(await this.apiDirecciones.listar());
    } catch {
      // El catalogo de direcciones es una ayuda, no un requisito: si no se
      // puede cargar, la pantalla sigue sirviendo para capturar y escribir la
      // direccion a mano. Un fallo aqui NO se pinta como error de la nota.
      this.direcciones.set([]);
    }
  }

  /**
   * Elige una direccion del catalogo y la pone en el campo.
   *
   * Recibe `number | string` porque la plantilla se la manda desde un
   * `<select>`: el valor de una opcion SIEMPRE llega como texto ("12"), y el
   * paso por `Number()` se hace aqui (o acepta el texto) en vez de dejarlo
   * en la plantilla, donde no hay conversion.
   *
   * El texto se COPIA al campo en vez de dejar el campo apuntando al
   * catalogo, porque el campo es lo que se imprime y lo que se manda: si el
   * campo dependiera del catalogo, borrarla del catalogo dejaria una nota sin
   * destino, que es justo lo que el diseno de la migracion 0011 evita.
   */
  elegirDireccion(id: number | string): void {
    const numero = typeof id === 'number' ? id : Number(id);
    const elegida = this.direcciones().find((otra) => otra.id === numero);
    if (elegida === undefined) return;
    this.direccion.set(elegida.direccion);
    this.direccionElegida.set(elegida.id);
    this.formaDireccion.set(null);
    this.errorDireccion.set(null);
  }

  /** Escribe a mano: lo que hay en el campo ya no es la del catalogo. */
  escribirDireccion(texto: string): void {
    this.direccion.set(texto);
    this.direccionElegida.set(null);
  }

  /** Abre el formulario para guardar lo escrito, con el nombre vacio. */
  abrirAltaDireccion(): void {
    this.formaDireccion.set({
      id: null,
      nombre: '',
      direccion: this.direccion().trim(),
    });
    this.errorDireccion.set(null);
  }

  /** Abre el formulario para corregir una direccion del catalogo. */
  abrirEdicionDireccion(id: number): void {
    const elegida = this.direcciones().find((otra) => otra.id === id);
    if (elegida === undefined) return;
    this.formaDireccion.set({
      id: elegida.id,
      nombre: elegida.nombre,
      direccion: elegida.direccion,
    });
    this.errorDireccion.set(null);
  }

  /** El formulario, campo por campo. El `id` es `null` en el alta. */
  enFormaDireccion(campo: 'nombre' | 'direccion', valor: string): void {
    this.formaDireccion.update((forma) => (forma === null ? forma : { ...forma, [campo]: valor }));
  }

  cerrarAltaDireccion(): void {
    this.formaDireccion.set(null);
    this.errorDireccion.set(null);
  }

  /**
   * Guarda la direccion del formulario: alta si no tiene id, correccion si
   * tiene.
   *
   * Despues de corregir una que ya estaba elegida, el texto del campo se
   * vuelve a copiar: si no, la pantalla seguiria mandando el texto viejo
   * mientras el catalogo ya dice el nuevo, y la proxima nota saldria con la
   * direccion que se acaba de corregir.
   */
  async guardarDireccion(): Promise<void> {
    const forma = this.formaDireccion();
    if (forma === null || !this.direccionGuardable()) return;

    this.guardandoDireccion.set(true);
    this.errorDireccion.set(null);
    try {
      const cuerpo = { nombre: forma.nombre.trim(), direccion: forma.direccion.trim() };
      const guardada =
        forma.id === null
          ? await this.apiDirecciones.crear(cuerpo)
          : await this.apiDirecciones.editar(forma.id, cuerpo);
      await this.cargarDirecciones();
      this.formaDireccion.set(null);
      this.direccion.set(guardada.direccion);
      this.direccionElegida.set(guardada.id);
    } catch (falla) {
      this.errorDireccion.set(errorLegible(falla).mensaje);
    } finally {
      this.guardandoDireccion.set(false);
    }
  }

  /**
   * Borra una direccion del catalogo.
   *
   * NO se pregunta si esta en uso porque no puede estarlo: la nota copio el
   * texto y no apunta al catalogo (migracion 0011). Lo que si se dice, con
   * `confirm`, es lo unico que se pierde: la direccion sale del desplegable,
   * y las notas que ya la traian la conservan.
   */
  async borrarDireccion(id: number): Promise<void> {
    const borrada = this.direcciones().find((otra) => otra.id === id);
    if (borrada === undefined) return;
    if (
      !confirmar(`¿Borrar "${borrada.nombre}" del catalogo? Las notas que ya la traen no cambian.`)
    ) {
      return;
    }

    this.errorDireccion.set(null);
    try {
      await this.apiDirecciones.borrar(id);
      this.direcciones.update((lista) => lista.filter((otra) => otra.id !== id));
      if (this.direccionElegida() === id) this.direccionElegida.set(null);
      if (this.formaDireccion()?.id === id) this.formaDireccion.set(null);
    } catch (falla) {
      this.errorDireccion.set(errorLegible(falla).mensaje);
    }
  }

  // ------------------------------------------------------ la tabla de notas
  async recargar(): Promise<void> {
    this.cargandoLista.set(true);
    this.errorLista.set(null);
    try {
      const respuesta = await this.api.listar({
        periodo: this.periodo() === 'todo' ? undefined : (this.periodo() as Periodo),
        buscar: this.buscar() === '' ? undefined : this.buscar(),
        limite: this.limite,
        offset: 0,
      });
      this.notas.set(respuesta.datos);
      this.totalNotas.set(respuesta.total);
    } catch (falla) {
      this.notas.set([]);
      this.totalNotas.set(0);
      this.errorLista.set(errorLegible(falla).mensaje);
    } finally {
      this.cargandoLista.set(false);
    }
  }

  /** Siguiente pagina. Se PEGA a lo que ya hay, no se reemplaza. */
  async cargarMas(): Promise<void> {
    if (!this.hayMas() || this.buscandoMas()) return;
    this.buscandoMas.set(true);
    this.errorLista.set(null);
    try {
      const respuesta = await this.api.listar({
        periodo: this.periodo() === 'todo' ? undefined : (this.periodo() as Periodo),
        buscar: this.buscar() === '' ? undefined : this.buscar(),
        limite: this.limite,
        offset: this.notas().length,
      });
      this.notas.update((ya) => [...ya, ...respuesta.datos]);
      this.totalNotas.set(respuesta.total);
    } catch (falla) {
      this.errorLista.set(errorLegible(falla).mensaje);
    } finally {
      this.buscandoMas.set(false);
    }
  }

  /** El buscador de la tabla: 250 ms, como todos los de la app. */
  aBuscar(texto: string): void {
    clearTimeout(this.temporizadorFiltros);
    this.temporizadorFiltros = setTimeout(() => {
      this.buscar.set(texto.trim());
      void this.recargar();
    }, 250);
  }

  aPeriodo(valor: string): void {
    this.periodo.set(valor as Periodo | 'todo');
    void this.recargar();
  }

  // ------------------------------------------------------- las acciones
  /**
   * Abrir y cerrar el detalle de una fila.
   *
   * Volver a apretar "Ver" la cierra, porque el mismo boton es el que dice
   * "Ocultar" cuando esta abierta; y abrir OTRA fila cambia la abierta, no
   * apila dos.
   */
  async ver(nota: NotaListada): Promise<void> {
    this.cerrarCancelacion();
    if (this.detalle()?.id === nota.id) {
      this.detalle.set(null);
      return;
    }
    this.cargandoDetalle.set(true);
    this.errorLista.set(null);
    try {
      this.detalle.set(await this.api.consultar(nota.id));
    } catch (falla) {
      this.errorLista.set(errorLegible(falla).mensaje);
    } finally {
      this.cargandoDetalle.set(false);
    }
  }

  /**
   * La devolucion: carga la nota en el formulario de arriba para bajar bultos
   * o quitar renglones.
   *
   * Antes se pregunta si hay algo a medias, porque esto REEMPLAZA lo que este
   * capturando. Sin la pregunta, un boton con el mismo nombre en cada fila
   * seria la forma mas rapida de perder media hora de captura.
   *
   * La nota se pide completa (`GET /:id`), no se arma con la fila de la
   * tabla: la fila no tiene renglones, y una devolucion sin renglones no se
   * puede capturar.
   */
  async devolver(nota: NotaListada): Promise<void> {
    this.cerrarCancelacion();
    if (this.hayLineas() && !confirmar('Se borra la nota que llevas capturando.')) return;
    if (
      this.editando() !== null &&
      !confirmar(`Se abandona la corrección de ${this.editando()?.folio}.`)
    )
      return;

    this.error.set(null);
    try {
      const completa = await this.api.consultar(nota.id);
      // El cliente viene de la nota y no del buscador: lo que hace falta es
      // el nombre para mostrarlo y el id para mandarlo, y la nota ya trae los
      // dos. Volver a buscarlo seria una peticion para nada.
      this.cliente.set({
        id: completa.cliente_id,
        nombre: completa.cliente,
        codigo_cliente: null,
        establo: null,
        rfc: null,
      });
      this.lineas.set(completa.renglones.map(lineaDeRenglon));
      this.direccion.set(completa.direccion_entrega ?? '');
      // El texto puede coincidir con una del catalogo, pero no se puede
      // saber cual es: se deja como direccion nueva. Si habia una elegida, se
      // olvida, porque el texto que se va a mandar es el de la nota.
      this.direccionElegida.set(null);
      this.editando.set(completa);
      this.ultimaGuardada.set(null);
      this.error.set(null);
      this.subirArriba();
    } catch (falla) {
      this.error.set(errorLegible(falla).mensaje);
    }
  }

  /**
   * Sube al formulario cuando hay algo a medio capturar.
   *
   * Sin esto, la devolucion se carga 500 pixeles arriba de donde esta el
   * boton que la pidio y la persona no ve nada cambiar hasta que scrollea. En
   * una pantalla de mostrador, "no paso nada" y "no se guardo" se ven igual.
   *
   * `behavior: 'smooth'` y no `instant`: la pantalla tiene que moverse, y un
   * salto seco a otra parte del documento en una pantalla tactil hace que la
   * mano se quede arriba.
   */
  private subirArriba(): void {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /** Cierra el formulario de edicion y deja la pantalla como una nota nueva. */
  cancelarEdicion(): void {
    this.editando.set(null);
    this.lineas.set(vaciar(this.lineas()));
    this.direccionElegida.set(null);
    this.error.set(null);
    this.subirArriba();
  }

  async imprimir(notaId: number): Promise<void> {
    this.errorLista.set(null);
    try {
      await this.api.abrirPdf(notaId);
    } catch (falla) {
      this.errorLista.set(errorLegible(falla).mensaje);
    }
  }

  /**
   * Descarga la nota en Excel.
   *
   * La plantilla del papel solo trae 9 renglones: si la nota lleva mas, el
   * Excel se descarga con los primeros 9 y aqui se avisa cuantos se
   * quedaron fuera, para que no se entregue una nota a medias como si fuera
   * completa.
   */
  async excel(notaId: number): Promise<void> {
    this.errorLista.set(null);
    try {
      const fuera = await this.api.abrirExcel(notaId);
      if (fuera > 0) {
        this.errorLista.set(
          `La nota tiene ${fuera} renglon${fuera === 1 ? '' : 'es'} de mas para el papel: el Excel va con los primeros 9.`,
        );
      }
    } catch (falla) {
      this.errorLista.set(errorLegible(falla).mensaje);
    }
  }

  /** Abre el motivo de la cancelacion debajo de la fila. */
  abrirCancelacion(nota: NotaListada): void {
    this.detalle.set(null);
    this.motivo.set('');
    this.errorLista.set(null);
    this.cancelando.set(nota);
  }

  cerrarCancelacion(): void {
    this.cancelando.set(null);
    this.motivo.set('');
  }

  /**
   * El motivo se valida aqui y en el backend.
   *
   * Los tres caracteres del backend son el minimo de `cancelarNotaEsquema`,
   * y se comprueba aqui para que el boton se apague y no para sustituir al
   * servidor: una cancelacion sin motivo es un boton que borra trabajo, y el
   * motivo es lo unico que queda de por que se hizo.
   */
  readonly motivoValido = computed(
    () => this.motivo().trim().length >= 3 && !this.guardandoCancelacion(),
  );

  async confirmarCancelacion(): Promise<void> {
    const nota = this.cancelando();
    if (nota === null || !this.motivoValido()) return;

    this.guardandoCancelacion.set(true);
    this.errorLista.set(null);
    try {
      await this.api.cancelar(nota.id, this.motivo().trim());
      this.cerrarCancelacion();
      await this.recargar();
    } catch (falla) {
      this.errorLista.set(errorLegible(falla).mensaje);
    } finally {
      this.guardandoCancelacion.set(false);
    }
  }

  /** Una nota se puede devolver solo mientras el backend la pueda editar. */
  sePuedeDevolver(nota: NotaListada): boolean {
    return nota.estatus === 'pendiente' || nota.estatus === 'parcial';
  }

  /** Por que no, en una linea, para el `title` del boton apagado. */
  porqueNoDevolver(nota: NotaListada): string {
    if (nota.estatus === 'pagada')
      return 'La nota ya esta pagada: cancelala si hay que deshacer el cobro';
    if (nota.estatus === 'cancelada') return 'Esta nota ya esta cancelada';
    return '';
  }

  /** Una nota cancelada ya no se cancela otra vez. */
  sePuedeCancelar(nota: NotaListada): boolean {
    return nota.estatus !== 'cancelada';
  }

  // -------------------------------------------------------------- el texto
  /** El total en pantalla, ya con los miles. Ver `totalComoTexto` de cifras. */
  totalComoTexto = computed(() => montoComoTexto(this.total()));

  /** El estatus, en el idioma del mostrador y no en el del esquema. */
  estatusComoTexto(estatus: EstatusNota): string {
    if (estatus === 'pendiente') return 'Pendiente';
    if (estatus === 'parcial') return 'Pagada parcial';
    if (estatus === 'pagada') return 'Pagada';
    return 'Cancelada';
  }
}

/**
 * `confirm` para las cosas que se pierden sin avisar.
 *
 * Va en un envoltorio y no suelto en la pantalla para que se pueda ver de
 * un vistazo que son las unicas preguntas que hace la app, y para que
 * si algun dia se cambia a un `dialog` propio se cambie en un solo lugar.
 */
function confirmar(pregunta: string): boolean {
  return window.confirm(pregunta);
}
