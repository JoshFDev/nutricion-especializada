import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { errorLegible } from '../nucleo/api';
import { Recarga, filasAnimation } from '../nucleo/animaciones';
import { montoComoTexto } from '../nucleo/cifras';
import { Sesion } from '../nucleo/sesion';
import {
  AuditoriaApi,
  ETIQUETA_EVENTO,
  ETIQUETA_OPERACION,
  cambiosDeFila,
  eventoSospechoso,
  fechaLegible,
  rangoDelMes,
  rangoIncoherente,
  type Cambio,
  type EventoAcceso,
  type Filtros,
  type Operacion,
  type RenglonAcceso,
  type RenglonCaja,
  type RenglonInventario,
  type RenglonLog,
  type RenglonPrecios,
} from './auditoria-api';

/**
 * Las cinco bitacoras, en una pantalla con pestanas.
 *
 * Es la pantalla mas rareta del proyecto y por eso casi todo lo suyo es
 * decision y no codigo:
 *
 *   - **Solo se muestran las pestanas que la persona puede ver.** Cada
 *     bitacora tiene su propio permiso (`auditoria.accesos`, `.caja`,
 *     `.inventario`, `.precios`) y el `auditoria.ver` del menu solo abre la
 *     pantalla. Con `auditoria.ver` y nada mas se ve una pestana, y no es
 *     un error de permisos: es alguien a quien le pasaron el acceso minimo.
 *   - **El filtro de fechas arranca en el mes que va** (`rangoDelMes`) y no
 *     en "todo". Una bitacora sin rango son miles de renglones y lo que se
 *     pregunta primero es "que paso hoy".
 *   - **Una bitacora no se edita ni se borra.** Ni la pantalla ni el
 *     backend tienen un endpoint para eso, y no es un hueco: es lo unico
 *     que una bitacora no puede permitir.
 *   - **El renglon del log trae el antes y el despues en crudo**, y quien
 *     arma el "que cambio" es la pantalla (`cambiosDeFila`). El backend no
 *     sabe que tablas hay ni que columnas tienen, y no deberia: si lo
 *     supiera, habria que tocarlo cada vez que se agregue una columna.
 *
 * Cada bitacora tiene SU PROPIA senal de filas en vez de una sola con el
 * renglon de las cinco. Es un poco mas de codigo, y a cambio el `@switch` de
 * la plantilla estrecha el tipo de verdad: con una lista comun el tipo seria
 * la union de las cinco y `renglon.operacion` no existiria en la de accesos.
 * Con un `any` se callaba el error, y ahi es donde se cuelan las columnas mal
 * escritas.
 */

/** Las cinco pestanas, con el permiso que cada una necesita. */
export type Bitacora = 'log' | 'accesos' | 'caja' | 'inventario' | 'precios';

interface Pestana {
  id: Bitacora;
  etiqueta: string;
  permiso: string;
  /** Si la bitacora acepta el filtro de busqueda de texto libre. */
  conBusqueda: boolean;
}

const PESTANAS: Pestana[] = [
  { id: 'log', etiqueta: 'Cambios', permiso: 'auditoria.ver', conBusqueda: true },
  { id: 'accesos', etiqueta: 'Accesos', permiso: 'auditoria.accesos', conBusqueda: true },
  { id: 'caja', etiqueta: 'Caja', permiso: 'auditoria.caja', conBusqueda: false },
  { id: 'inventario', etiqueta: 'Inventario', permiso: 'auditoria.inventario', conBusqueda: false },
  { id: 'precios', etiqueta: 'Precios', permiso: 'auditoria.precios', conBusqueda: false },
];

@Component({
  selector: 'app-auditoria',
  templateUrl: './auditoria.html',
  styleUrl: './auditoria.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  animations: [filasAnimation],
})
export class Auditoria {
  private readonly api = inject(AuditoriaApi);
  private readonly sesion = inject(Sesion);

  // --------------------------------------------------------------- las pestanas
  /**
   * Las pestanas visibles.
   *
   * Si `auditoria.ver` no alcanzara para ninguna, se cae a la primera: el
   * menu ya abrio esta pantalla porque el permiso estaba, y un `null` en el
   * `@for` dejaria un hueco en vez de un mensaje.
   */
  readonly pestanas = computed(() => {
    const permitidas = PESTANAS.filter((pestana) => this.sesion.puede(pestana.permiso));
    return permitidas;
  });

  readonly abierta = signal<Bitacora>('log');

  /** La pestana abierta, ya con su bandera de busqueda. */
  private readonly actual = computed(
    () => this.pestanas().find((pestana) => pestana.id === this.abierta()) ?? null,
  );
  readonly conBusqueda = computed(() => this.actual()?.conBusqueda ?? false);

  // ---------------------------------------------------------------- los filtros
  readonly desde = signal<string | undefined>(rangoDelMes().desde);
  readonly hasta = signal<string | undefined>(rangoDelMes().hasta);
  readonly buscador = signal('');
  readonly filtroOperacion = signal<Operacion | ''>('');
  readonly filtroEvento = signal<EventoAcceso | ''>('');
  readonly filtroTipo = signal<string>('');

  /**
   * Con el boton de aplicar apagado, y con el motivo a la vista.
   *
   * El backend ya devuelve 422 en este caso, pero preguntar aqui evita el
   * viaje y deja el motivo escrito en la pantalla.
   */
  readonly rangoMalo = computed(() => rangoIncoherente(this.desde(), this.hasta()));
  readonly botonActivo = computed(() => !this.rangoMalo() && !this.cargando());

  // ------------------------------------------------------------------- el listado
  readonly filas = {
    log: signal<RenglonLog[]>([]),
    accesos: signal<RenglonAcceso[]>([]),
    caja: signal<RenglonCaja[]>([]),
    inventario: signal<RenglonInventario[]>([]),
    precios: signal<RenglonPrecios[]>([]),
  };
  readonly total = signal(0);
  readonly cargando = signal(false);
  readonly error = signal<string | null>(null);

  /**
   * La paginacion, en vez del "cargar mas" de antes.
   *
   * El cambio no es cosmetico. Con "cargar mas" las filas se agregan al final
   * de la lista, asi que en una bitacora de miles de renglones no habia forma
   * de volver a donde ya se estaba ni de saber en que pagina se esta: solo de
   * bajar y bajar. Con paginas, el ultimo renglon del mes se abre con la misma
   * cantidad de clics que el primero, que en auditoria es justo el caso de uso.
   *
   * A diferencia de las otras pantallas, aqui las filas de la pagina anterior
   * NO se conservan: `cargar` reemplaza la senal de la bitacora abierta en vez
   * de pegarle al final (antes `pegar`/`cargarMas`). Un renglon de log es de
   * solo lectura y no se edita desde la tabla, asi que no hay nada que se
   * pierda de una vista a la otra, y mantener todas las paginas en memoria
   * solo servia para que el scroll quedara largo.
   */
  readonly limite = signal(50);
  readonly pagina = signal(1);

  /** Para la cascada de entrada de la tabla. Ver `nucleo/animaciones.ts`. */
  readonly recarga = new Recarga();

  readonly paginasTotales = computed(() => Math.max(1, Math.ceil(this.total() / this.limite())));
  readonly hayPaginaAnterior = computed(() => this.pagina() > 1);
  readonly hayPaginaSiguiente = computed(() => this.pagina() < this.paginasTotales());
  readonly rangoDePagina = computed(() => {
    const total = this.total();
    if (total === 0) return '0 de 0';
    const desde = (this.pagina() - 1) * this.limite() + 1;
    const hasta = Math.min(this.pagina() * this.limite(), total);
    return `${desde}-${hasta} de ${total}`;
  });

  /** El tamano de pagina como texto, para el `[value]` del desplegable. */
  limiteComoTexto(): string {
    return String(this.limite());
  }

  async aTamanoDePagina(valor: string): Promise<void> {
    this.limite.set(Number(valor));
    this.pagina.set(1);
    await this.cargar();
  }

  async irPagina(pagina: number): Promise<void> {
    if (pagina < 1 || pagina > this.paginasTotales() || pagina === this.pagina()) return;
    this.pagina.set(pagina);
    await this.cargar();
  }

  // ------------------------------------------------------------ el detalle del renglon
  /** El renglon abierto, para ver que campos se movieron. */
  readonly abiertoLog = signal<RenglonLog | null>(null);
  readonly cambios = computed<Cambio[]>(() => {
    const renglon = this.abiertoLog();
    if (renglon === null) return [];
    return cambiosDeFila(renglon.datos_anteriores, renglon.datos_nuevos);
  });

  // Para la plantilla: funciones puras, para que se lean ahi sin this.
  fechaLegible = fechaLegible;
  eventoSospechoso = eventoSospechoso;
  montoComoTexto = montoComoTexto;
  ETIQUETA_EVENTO = ETIQUETA_EVENTO;
  ETIQUETA_OPERACION = ETIQUETA_OPERACION;

  /** Los eventos de acceso, para el desplegable del filtro. */
  readonly eventos = Object.keys(ETIQUETA_EVENTO) as EventoAcceso[];

  constructor() {
    // Con estos permisos puede que la pestana de "Cambios" no exista. Se
    // arranca en la primera que se pueda ver, y esa es la que se carga.
    const primera = this.pestanas()[0];
    if (primera) this.abierta.set(primera.id);
    void this.cargar();
  }

  // --------------------------------------------------------------- las pestanas

  cambiarDePestana(bitacora: Bitacora): void {
    this.abierta.set(bitacora);
    this.abiertoLog.set(null);
    this.error.set(null);
    // Cada bitacora filtra por una cosa distinta y el filtro de otra no
    // significa nada aqui: dejarlos puestos seria mandar un parametro que
    // el esquema de la otra ni siquiera acepta.
    this.filtroOperacion.set('');
    this.filtroEvento.set('');
    this.filtroTipo.set('');
    this.buscador.set('');
    // La paginacion tambien vuelve a la primera: los filtros que se limpian son
    // de esta bitacora, y la pagina 3 de la anterior no significa nada en la
    // nueva.
    this.pagina.set(1);
    void this.cargar();
  }

  // ---------------------------------------------------------------- los filtros

  ponerDesde(fecha: string): void {
    this.desde.set(fecha === '' ? undefined : fecha);
  }

  ponerHasta(fecha: string): void {
    this.hasta.set(fecha === '' ? undefined : fecha);
  }

  /** El rango por omision: el mes que va. */
  filtroDelMes(): void {
    const rango = rangoDelMes();
    this.desde.set(rango.desde);
    this.hasta.set(rango.hasta);
  }

  /** Sin fechas: toda la bitacora. Los demas filtros se quedan. */
  quitarFechas(): void {
    this.desde.set(undefined);
    this.hasta.set(undefined);
  }

  buscar(texto: string): void {
    this.buscador.set(texto);
  }

  filtrarOperacion(operacion: string): void {
    this.filtroOperacion.set(operacion as Operacion | '');
  }

  filtrarEvento(evento: string): void {
    this.filtroEvento.set(evento as EventoAcceso | '');
  }

  filtrarTipo(tipo: string): void {
    this.filtroTipo.set(tipo);
  }

  // ------------------------------------------------------------------ el listado

  recargar(): void {
    this.pagina.set(1);
    void this.cargar();
  }

  /**
   * Carga la pagina abierta de la bitacora abierta.
   *
   * El `switch` esta porque cada una tiene su filtro propio y ninguna los
   * acepta todos: mandarle `buscar` a la de caja es un 400 del `strict` del
   * esquema, no un filtro que se ignore en silencio. Y es tambien donde cada
   * respuesta cae en la senal de SU tipo, que es lo que hace que la
   * plantilla no tenga que inventarse el tipo del renglon.
   */
  private async cargar(): Promise<void> {
    if (this.rangoMalo()) return;
    this.cargando.set(true);
    this.error.set(null);
    const bitacora = this.abierta();
    const comunes: Filtros = {
      desde: this.desde(),
      hasta: this.hasta(),
      buscar: this.buscador().trim() || undefined,
      limite: this.limite(),
      offset: (this.pagina() - 1) * this.limite(),
    };

    try {
      switch (bitacora) {
        case 'log': {
          const r = await this.api.log({
            ...comunes,
            // El `as` es porque `''` es el estado de "sin filtro" y TypeScript
            // no lo descarta solo: son dos estados en una senal, no un enum.
            operacion: (this.filtroOperacion() || null) as Operacion | null,
          });
          this.filas.log.set(r.datos);
          this.total.set(r.total);
          break;
        }
        case 'accesos': {
          const r = await this.api.accesos({
            ...comunes,
            evento: (this.filtroEvento() || null) as EventoAcceso | null,
          });
          this.filas.accesos.set(r.datos);
          this.total.set(r.total);
          break;
        }
        case 'caja': {
          const r = await this.api.caja({
            ...comunes,
            tipo: this.filtroTipo() === '' ? null : (this.filtroTipo() as 'ingreso' | 'egreso'),
          });
          this.filas.caja.set(r.datos);
          this.total.set(r.total);
          break;
        }
        case 'inventario': {
          const r = await this.api.inventario(comunes);
          this.filas.inventario.set(r.datos);
          this.total.set(r.total);
          break;
        }
        case 'precios': {
          const r = await this.api.precios({
            ...comunes,
            tipo_precio:
              this.filtroTipo() === ''
                ? null
                : (this.filtroTipo() as 'cliente' | 'publico' | 'costo'),
          });
          this.filas.precios.set(r.datos);
          this.total.set(r.total);
          break;
        }
      }
    } catch (falla) {
      this.error.set(errorLegible(falla).mensaje);
    } finally {
      this.cargando.set(false);
      // Aqui y no dentro del `try`: el renglon se marca como recargado tanto si
      // la respuesta llego como si fallo, porque en los dos casos las filas
      // cambiaron y la cascada de entrada es lo que avisa de que la tabla se
      // repinto.
      this.recarga.marcar();
    }
  }

  // ------------------------------------------------------------------- el detalle

  ver(renglon: RenglonLog): void {
    this.abiertoLog.set(renglon);
  }

  cerrar(): void {
    this.abiertoLog.set(null);
  }
}
