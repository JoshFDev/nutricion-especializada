import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { filasAnimation, Recarga } from '../nucleo/animaciones';
import { errorLegible } from '../nucleo/api';
import { bultosComoTexto, kilosComoTexto, montoComoTexto } from '../nucleo/cifras';
import {
  ReportesApi,
  type Consumo,
  type EstadoCuenta,
  type Existencia,
  type Filtros,
} from './reportes-api';

/**
 * La pantalla de reportes: tres vistas del negocio en tres pestanas.
 *
 * Son las consultas que 0001 dejo calculando y que hasta ahora no tenian ni
 * endpoint ni pantalla. Cada pestana es una vista distinta y por eso cada una
 * tiene SU PROPIA senal de filas: es lo que hace que el `@switch` de la
 * plantilla estreche el tipo de verdad, y que una columna mal escrita sea un
 * error de compilacion en vez de un `undefined` en pantalla.
 *
 * Las tres son de SOLO LECTURA: no hay formulario, ni boton de guardar, ni
 * edicion. Lo que se ve lo calcula la base a partir de las ventas, las compras
 * y los pagos; la pantalla solo lo muestra y lo filtra.
 *
 * La existencia puede salir NEGATIVA y no se esconde: es una venta capturada
 * antes que su compra, y un negativo en el papel es justo lo que hay que ir a
 * revisar. Por eso se pinta en rojo, con el mismo criterio que el inventario.
 */

/** Las tres pestanas. */
export type Reporte = 'existencia' | 'consumo' | 'estado';

interface Pestana {
  id: Reporte;
  etiqueta: string;
  /** Que explica el estado vacio de esta pestana. */
  vacio: string;
}

const PESTANAS: Pestana[] = [
  {
    id: 'existencia',
    etiqueta: 'Existencia',
    vacio: 'No hay productos que coincidan. Prueba con otra búsqueda.',
  },
  {
    id: 'consumo',
    etiqueta: 'Consumo semanal',
    vacio: 'No hay ventas de las últimas 8 semanas que coincidan con la búsqueda.',
  },
  {
    id: 'estado',
    etiqueta: 'Estado de cuenta',
    vacio: 'No hay clientes que coincidan con la búsqueda.',
  },
];

@Component({
  selector: 'app-reportes',
  templateUrl: './reportes.html',
  styleUrl: './reportes.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  animations: [filasAnimation],
})
export class Reportes {
  private readonly api = inject(ReportesApi);

  readonly pestanas = PESTANAS;
  readonly abierta = signal<Reporte>('existencia');

  /** La pestana abierta, para saber que filtro propio dibujar. */
  readonly actual = computed(() => PESTANAS.find((p) => p.id === this.abierta()) ?? PESTANAS[0]);

  // ------------------------------------------------------------------ filtros
  readonly buscador = signal('');
  readonly soloConExistencia = signal(false);
  readonly soloConSaldo = signal(false);

  /**
   * Con lo que el buscador aporta, no con cada tecla que se pulsa.
   *
   * El buscador se manda al backend y el backend filtra por ILIKE, asi que el
   * valor viaja tal cual. El minimo de dos caracteres esta en la API, no aqui:
   * esta senal solo sirve para decidir si el boton "Limpiar" aparece.
   */
  readonly hayFiltros = computed(
    () => this.buscador().trim().length >= 2 || this.soloConExistencia() || this.soloConSaldo(),
  );

  // ------------------------------------------------------------------ listado
  readonly filas = {
    existencia: signal<Existencia[]>([]),
    consumo: signal<Consumo[]>([]),
    estado: signal<EstadoCuenta[]>([]),
  };
  readonly total = signal(0);
  readonly cargando = signal(false);
  readonly error = signal<string | null>(null);

  /** Paginacion, igual que en el resto de los listados. */
  readonly limite = signal(25);
  readonly pagina = signal(1);

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

  /** Para la cascada de entrada de la tabla. Ver `nucleo/animaciones.ts`. */
  readonly recarga = new Recarga();

  // Para la plantilla: funciones puras, para que se lean ahi sin `this`.
  bultosComoTexto = bultosComoTexto;
  kilosComoTexto = kilosComoTexto;
  montoComoTexto = montoComoTexto;

  /** La fecha de una venta o un pago, o un guion si nunca ocurrio. */
  fecha(fecha: string | null): string {
    return fecha ?? '—';
  }

  constructor() {
    void this.recargar();
  }

  // --------------------------------------------------------------- las pestanas

  cambiarDePestana(reporte: Reporte): void {
    clearTimeout(this.temporizador);
    this.abierta.set(reporte);
    // El filtro de una pestana no significa nada en la otra: la busqueda se
    // limpia al cambiar, que es como se comporta tambien la auditoria.
    this.buscador.set('');
    this.soloConExistencia.set(false);
    this.soloConSaldo.set(false);
    this.pagina.set(1);
    void this.recargar();
  }

  // ------------------------------------------------------------------ filtros

  private temporizador: ReturnType<typeof setTimeout> | undefined;

  /**
   * Busca con 250 ms de espera, igual que el resto de las pantallas.
   *
   * Cada tecleo NO pega una peticion: con el buscador a media escritura son
   * varias y la ultima es la unica que sirve. Y vuelve siempre a la pagina 1,
   * porque quedarse en la 4 con una busqueda nueva es mirar un `offset` que ya
   * no significa nada.
   */
  buscar(texto: string): void {
    clearTimeout(this.temporizador);
    this.buscador.set(texto);
    this.temporizador = setTimeout(() => void this.recargar(), 250);
  }

  toggleSoloConExistencia(): void {
    this.soloConExistencia.update((valor) => !valor);
    void this.recargar();
  }

  toggleSoloConSaldo(): void {
    this.soloConSaldo.update((valor) => !valor);
    void this.recargar();
  }

  limpiarFiltros(): void {
    clearTimeout(this.temporizador);
    this.buscador.set('');
    this.soloConExistencia.set(false);
    this.soloConSaldo.set(false);
    void this.recargar();
  }

  private textoBusqueda(): string | undefined {
    const limpio = this.buscador().trim();
    return limpio.length >= 2 ? limpio : undefined;
  }

  private async recargar(): Promise<void> {
    await this.cargarPagina(1);
  }

  /** El tamano de pagina como texto, para el `[value]` del desplegable. */
  limiteComoTexto(): string {
    return String(this.limite());
  }

  async aTamanoDePagina(valor: string): Promise<void> {
    const limite = Number(valor);
    if (!Number.isFinite(limite) || limite <= 0 || limite === this.limite()) return;
    this.limite.set(limite);
    // Vuelve siempre a la pagina 1: la pagina 7 con otro tamano es un `offset`
    // que ya no corresponde a nada.
    await this.recargar();
  }

  async irPagina(pagina: number): Promise<void> {
    if (pagina < 1 || pagina > this.paginasTotales() || pagina === this.pagina()) return;
    await this.cargarPagina(pagina);
  }

  // ------------------------------------------------------------------ el listado

  /**
   * Carga una pagina del reporte abierto.
   *
   * El `switch` esta porque cada pestana tiene su filtro propio y su propia
   * senal: mandarle `solo_con_saldo` a la existencia es un 400 del `strict`
   * del esquema, no un filtro que se ignore.
   */
  private async cargarPagina(pagina: number): Promise<void> {
    this.cargando.set(true);
    this.error.set(null);
    const comunes: Filtros = {
      buscar: this.textoBusqueda(),
      limite: this.limite(),
      offset: (pagina - 1) * this.limite(),
    };

    try {
      switch (this.abierta()) {
        case 'existencia': {
          const r = await this.api.existencia({
            ...comunes,
            solo_con_existencia: this.soloConExistencia(),
          });
          this.filas.existencia.set(r.datos);
          this.total.set(r.total);
          break;
        }
        case 'consumo': {
          const r = await this.api.consumo(comunes);
          this.filas.consumo.set(r.datos);
          this.total.set(r.total);
          break;
        }
        case 'estado': {
          const r = await this.api.estadoCuenta({
            ...comunes,
            solo_con_saldo: this.soloConSaldo(),
          });
          this.filas.estado.set(r.datos);
          this.total.set(r.total);
          break;
        }
      }
      this.pagina.set(pagina);
    } catch (falla) {
      this.filas.existencia.set([]);
      this.filas.consumo.set([]);
      this.filas.estado.set([]);
      this.total.set(0);
      this.error.set(errorLegible(falla).mensaje);
    } finally {
      this.cargando.set(false);
      // Aqui y no dentro del `try`: la cascada de entrada avisa de que la
      // tabla se repinto, tanto si la respuesta llego como si fallo.
      this.recarga.marcar();
    }
  }
}
