/**
 * Los atajos de teclado, para la Ayuda.
 *
 * No es una lista de lo que se podría llegar a implementar: cada renglón de
 * aquí existe en el código hoy. Si se agrega un atajo, se agrega aquí, y si se
 * quita, se quita; una guía que promete un atajo que no hace nada es peor que
 * no tener la sección.
 *
 * `teclas` se escribe con los nombres como salen en el teclado. La ayuda los
 * pinta como teclas separadas (ver `shell/ayuda.html`), así que cada tecla va
 * como su propio elemento del arreglo.
 */
export interface Atajo {
  /** Las teclas, en orden de pulsación. P. ej. ["Ctrl", "Enter"]. */
  teclas: string[];
  /** Qué hace. En infinitivo de instrucción, una línea. */
  accion: string;
}

export const ATAJOS: Atajo[] = [
  {
    teclas: ['Esc'],
    accion: 'Cierra la ventana abierta o limpia los filtros de la pantalla.',
  },
  {
    teclas: ['Ctrl', 'Enter'],
    accion: 'Guarda la captura en los formularios que lo admiten (el editor de productos).',
  },
  {
    teclas: ['Enter'],
    accion:
      'Guarda o confirma en otras capturas, como el editor de precios o el alta de una bodega.',
  },
  {
    teclas: ['Tab'],
    accion: 'Avanza de un campo o botón al siguiente, sin usar el ratón.',
  },
];
