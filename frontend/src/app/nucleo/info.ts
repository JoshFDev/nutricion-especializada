/**
 * Los datos de la aplicación que se muestran en la Ayuda y en "Acerca de".
 *
 * Van en UN archivo y no repartidos por las pantallas para que cambiar la razón
 * social, el correo de soporte o el número de versión sea tocar un solo lugar.
 * Es lo que la gente ve cuando pregunta "¿qué versión trae esto?" o "¿a dónde
 * escribo si falla?", y tenerlo regado es la forma de que un día digan cosas
 * distintas en dos pantallas.
 *
 * La versión se sube a mano al cerrar un lote de cambios. No se lee del
 * `package.json` por una razón simple: ese campo es del paquete y no de lo que
 * la gente ve, y amarrarlos obliga a publicar por un número.
 *
 * El correo y el teléfono son de EJEMPLO: cámbialos por los de verdad antes de
 * entregar. Mientras no se cambien, "Soporte" abre un correo a una dirección
 * que probablemente no existe.
 */
export const INFO_SISTEMA = {
  nombre: 'Nutrición Especializada',
  descripcion: 'Punto de venta, inventario y cobranza para alimento forrajero.',
  /** Se sube a mano. Ver la nota de arriba. */
  version: '1.0.0',
  /** La razón social, la que va en el pie de "Acerca de". */
  empresa: 'Nutrición Especializada',
  soporte: {
    /** Cambiar por el correo de soporte real. */
    correo: 'soporte@nutricionespecializada.mx',
    /** Cambiar por el teléfono real, o dejar vacío para no mostrarlo. */
    telefono: '',
    horario: 'Lunes a viernes, de 9:00 a 18:00',
  },
  /** Lo que corre por debajo. Se muestra como una línea informativa. */
  tecnologia: 'Angular · Node.js · PostgreSQL',
} as const;
