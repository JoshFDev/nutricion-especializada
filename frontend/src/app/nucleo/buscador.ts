import { computed, signal, type Signal } from '@angular/core';

/**
 * Un campo de busqueda con su lista de resultados.
 *
 * Nacio en `precios.ts`, donde los cuatro campos de la pantalla (producto y
 * cliente, en el filtro y en el editor) hacian exactamente lo mismo: esperar a
 * que se termine de escribir, preguntar una vez, y pegar la lista bajo el
 * campo. Con cuatro copias, cualquier arreglo se aplicaba cuatro veces y una
 * se quedaba sin arreglar. Ahora vive aqui, y `compras` reusa el mismo.
 *
 * El comportamiento completo, en una sola pieza:
 *
 *   - Escribe con 250 ms de espera: sin eso, teclear "VIM" dispara tres
 *     peticiones y las respuestas llegan en desorden, y la lista termina
 *     mostrando lo de "VI" despues de lo de "VIM".
 *   - Una respuesta vieja no pisa una nueva: cada pregunta lleva su `turno` y
 *     solo la ultima escribe. Sin eso, la lista parpadea con resultados que
 *     ya no corresponden a lo tecleado.
 *   - El `focusout` espera 150 ms antes de cerrar, porque el `focusout` llega
 *     ANTES del clic en la opcion: cerrar en el acto borra el boton que el
 *     operador todavia no ha soltado y la eleccion se pierde.
 *
 * Es una fabrica y no un componente a proposito: cada pantalla declara sus
 * campos con el `cargar` que le toca y recibe signals, sin `@Input` ni
 * `@Output` que enlazar. El estado vive en quien la usa, que es quien sabe
 * que hacer cuando se elige una opcion (`alElegir`).
 */
export interface Buscador<T> {
  /** El texto del campo. Va ligado al input para poder vaciarlo. */
  readonly texto: Signal<string>;
  /** Si la lista esta desplegada. Se cierra sola al salir del campo. */
  readonly lista: Signal<boolean>;
  readonly opciones: Signal<T[]>;
  /** El aviso de "nada con ese nombre", vacio cuando no aplica. */
  readonly sinNada: Signal<string>;
  escribir(texto: string): void;
  /** Al volver al campo con el mismo texto, la lista se reabre. */
  alEntrar(): void;
  /** En el `focusout` del campo. */
  alSalir(evento: FocusEvent): void;
  elegir(opcion: T): void;
  /** Vaciar el campo: se usa cuando se quita lo que ya se habia elegido. */
  limpiar(): void;
  /** Cerrar la lista sin tocar el texto (tecla Escape). */
  cerrar(): void;
}

export function crearBuscador<T>(cfg: {
  cargar: (texto: string) => Promise<T[]>;
  /** Cuantos caracteres hay que escribir antes de preguntar al servidor. */
  minimo: number;
  /** Lo que se dice cuando la pregunta no trae nada. */
  nada: (texto: string) => string;
  alElegir: (opcion: T) => void;
}): Buscador<T> {
  const texto = signal('');
  const opciones = signal<T[]>([]);
  const abierta = signal(false);
  /**
   * Que una pregunta YA respondio. Sin esto, una lista vacia no se distingue
   * de "todavia no se ha preguntado" y el campo parece ignorado.
   */
  const respondio = signal(false);
  const lista = computed(() => abierta() && opciones().length > 0);
  const sinNada = computed(() =>
    abierta() && respondio() && opciones().length === 0 ? cfg.nada(texto().trim()) : '',
  );
  let temporizador: ReturnType<typeof setTimeout> | undefined;
  /** Numero de pregunta en curso: una respuesta vieja no pisa una mas nueva. */
  let turno = 0;

  function cerrar(): void {
    clearTimeout(temporizador);
    turno++;
    abierta.set(false);
  }

  async function preguntar(limpio: string): Promise<void> {
    const mio = ++turno;
    try {
      const halladas = await cfg.cargar(limpio);
      if (mio !== turno) return;
      opciones.set(halladas);
    } catch {
      if (mio !== turno) return;
      opciones.set([]);
    } finally {
      if (mio === turno) respondio.set(true);
    }
  }

  return {
    texto: texto.asReadonly(),
    lista,
    opciones: opciones.asReadonly(),
    sinNada,
    escribir(nuevo: string): void {
      clearTimeout(temporizador);
      texto.set(nuevo);
      respondio.set(false);
      const limpio = nuevo.trim();
      if (limpio.length < cfg.minimo) {
        opciones.set([]);
        cerrar();
        return;
      }
      abierta.set(true);
      temporizador = setTimeout(() => void preguntar(limpio), 250);
    },
    alEntrar(): void {
      if (texto().trim().length >= cfg.minimo) abierta.set(true);
    },
    alSalir(evento: FocusEvent): void {
      /*
       * Se espera antes de cerrar porque el `focusout` llega ANTES del clic
       * en la opcion: cerrar en el acto borra el boton que el operador
       * todavia no ha soltado y la eleccion se pierde. Un turno alcanza para
       * un clic normal; 150 ms dan margen a uno lento.
       */
      const campo = evento.currentTarget;
      setTimeout(() => {
        const activo = document.activeElement;
        if (campo instanceof Node && activo instanceof Node && campo.contains(activo)) return;
        cerrar();
      }, 150);
    },
    elegir(opcion: T): void {
      cerrar();
      cfg.alElegir(opcion);
    },
    limpiar(): void {
      clearTimeout(temporizador);
      turno++;
      texto.set('');
      opciones.set([]);
      respondio.set(false);
      cerrar();
    },
    cerrar,
  };
}
