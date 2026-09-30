/**
 * Formas del catalogo de direcciones de entrega.
 *
 * Es un catalogo con DOS textos: `nombre` (la etiqueta con la que se
 * reconoce el destino) y `direccion` (el texto que se imprime). El catalogo
 * de especies y categorias solo tiene `nombre`, asi que esta tabla no cabe
 * en el `FilaCatalogo` generico de `modules/catalogo` sin deformarlo: ahi la
 * idea es que el recurso solo cambia de tabla y nombre, y aqui ademas cambia
 * la forma.
 *
 * `DireccionEntrega` es lo que sale por la API, y lo que ve el mostrador.
 */
export interface DireccionEntrega {
  id: number;
  nombre: string;
  direccion: string;
}

/** Como la devuelve `pg`: SMALLINT llega como numero, los TEXT como texto. */
export interface FilaDireccion {
  id: number;
  nombre: string;
  direccion: string;
}
