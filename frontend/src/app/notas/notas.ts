import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { errorLegible } from '../nucleo/api';
import { Sesion } from '../nucleo/sesion';
import { bultosComoTexto, kilosComoTexto, montoComoTexto } from '../nucleo/cifras';
import {
  agregar,
  cambiarCantidad,
  cambiarKilos,
  conPrecio,
  kilosDeLinea,
  kilosDeLineas,
  lineaVacia,
  montoDeLinea,
  origenComoTexto,
  problemasDe,
  quitar,
  totalDeLineas,
  vaciar,
  type Linea,
} from './linea';
import { NotasApi, cuerpoDeNota, type Cliente, type Nota, type Producto } from './notas-api';

/**
 * El mostrador: capturar una nota de remision.
 *
 * La pantalla es de TRES pasos en una sola vista, sin paginas entre ellos:
 * cliente, producto, renglones. En un mostrador el operador esta parado con
 * el cliente enfrente y la mercancia en el piso, y cada paso que implique
 * un "siguiente" es un paso que se equivoca.
 *
 * Tres decisiones que no son obviouses:
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
 */
@Component({
  selector: 'app-notas',
  templateUrl: './notas.html',
  styleUrl: './notas.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Notas {
  private readonly api = inject(NotasApi);
  private readonly sesion = inject(Sesion);

  // ------------------------------------------------------------- el estado
  readonly cliente = signal<Cliente | null>(null);
  readonly lineas = signal<Linea[]>([]);
  readonly direccion = signal('');

  /** Resultados de los dos buscadores. */
  readonly resultadosCliente = signal<Cliente[]>([]);
  readonly resultadosProducto = signal<Producto[]>([]);
  readonly buscandoCliente = signal(false);
  readonly buscandoProducto = signal(false);

  /** El renglon al que se le esta preguntando el precio, para no duplicar. */
  readonly preguntando = signal<number | null>(null);

  readonly guardando = signal(false);
  readonly error = signal<string | null>(null);
  /** La nota ya guardada: cuando esta, la pantalla es un comprobante. */
  readonly guardada = signal<Nota | null>(null);

  // ------------------------------------------------------------- lo derivado
  readonly total = computed(() => totalDeLineas(this.lineas()));
  readonly kilos = computed(() => kilosDeLineas(this.lineas()));
  readonly hayLineas = computed(() => this.lineas().length > 0);

  /**
   * Se puede guardar con cliente y al menos un renglon, y con todas las
   * lineas válidas.
   *
   * El boton se apaga en vez de dejar que el backend responda 422: el
   * operador ve que falta algo sin tener que interpretarlo.
   */
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

  readonly puedeGuardar = computed(
    () =>
      this.cliente() !== null &&
      this.hayLineas() &&
      this.lineas().every((linea) => Object.keys(problemasDe(linea)).length === 0) &&
      this.puedeCrear() &&
      !this.guardando(),
  );

  // ------------------------------------------------------------- el buscador
  private temporizadorCliente: ReturnType<typeof setTimeout> | undefined;
  private temporizadorProducto: ReturnType<typeof setTimeout> | undefined;

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
   * capturado media dozen de renglones. Preguntando primero, el error sale
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
  async guardar(): Promise<void> {
    const cliente = this.cliente();
    if (cliente === null || this.guardando()) return;

    this.guardando.set(true);
    this.error.set(null);
    try {
      const cuerpo = cuerpoDeNota(cliente.id, this.lineas(), this.direccion());
      this.guardada.set(await this.api.crear(cuerpo));
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

  async imprimir(): Promise<void> {
    const nota = this.guardada();
    if (nota === null) return;
    this.error.set(null);
    try {
      await this.api.abrirPdf(nota.id);
    } catch (falla) {
      this.error.set(errorLegible(falla).mensaje);
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
  async excel(): Promise<void> {
    const nota = this.guardada();
    if (nota === null) return;
    this.error.set(null);
    try {
      const fuera = await this.api.abrirExcel(nota.id);
      if (fuera > 0) {
        this.error.set(
          `La nota tiene ${fuera} renglon${fuera === 1 ? '' : 'es'} de mas para el papel: el Excel va con los primeros 9.`,
        );
      }
    } catch (falla) {
      this.error.set(errorLegible(falla).mensaje);
    }
  }

  /** Vuelve a la captura, con el cliente puesto: la mayoria son del mismo. */
  otraNota(): void {
    this.guardada.set(null);
    this.lineas.set([]);
    this.direccion.set('');
    this.error.set(null);
  }

  // -------------------------------------------------------------- el texto
  /** El total en pantalla, ya con los miles. Ver `totalComoTexto` de cifras. */
  totalComoTexto = computed(() => montoComoTexto(this.total()));
}

/**
 * `confirm` para las dos cosas que se pierden sin avisar.
 *
 * Va en un envoltorio y no suelto en la pantalla para que se pueda ver de
 * un vistazo que son las dos unicas preguntas que hace la app, y para que
 * si algun dia se cambia a un `dialog` propio se cambie en un solo lugar.
 */
function confirmar(pregunta: string): boolean {
  return window.confirm(pregunta);
}
