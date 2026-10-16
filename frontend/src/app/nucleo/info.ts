/**
 * Los datos de la aplicación que se muestran en la Ayuda y en "Acerca de".
 *
 * Van en UN archivo y no repartidos por las pantallas para que cambiar el
 * nombre del proveedor o el número de versión sea tocar un solo lugar. Es lo
 * que la gente ve cuando pregunta "¿quién le da mantenimiento a esto?" o
 * "¿qué versión trae?", y tenerlo regado es la forma de que un día digan cosas
 * distintas en dos pantallas.
 *
 * La versión se sube a mano al cerrar un lote de cambios. No se lee del
 * `package.json` por una razón simple: ese campo es del paquete y no de lo que
 * la gente ve, y amarrarlos obliga a publicar por un número.
 */
export const INFO_SISTEMA = {
  nombre: 'Nutrición Especializada',
  descripcion: 'Punto de venta, inventario y cobranza para alimento forrajero.',
  /** Se sube a mano. Ver la nota de arriba. */
  version: '1.0.0',
  /** La razón social, la que va en el pie de "Acerca de". */
  empresa: 'Nutrición Especializada',
  /**
   * Quién desarrolla y da soporte al sistema: la persona a la que se le habla
   * cuando algo falla o cuando se quiere pedir un cambio. Es lo que sale en
   * "Soporte" y en "Acerca de", en lugar de un correo o un teléfono sueltos.
   */
  proveedor: {
    nombre: 'Joshua Sebastián Aboytes Uribe',
    rol: 'Desarrollo y soporte del sistema',
    horario: 'Lunes a viernes, de 9:00 a 18:00',
  },
} as const;
