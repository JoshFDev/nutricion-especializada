/**
 * El catálogo de módulos de la aplicación.
 *
 * Aquí está la lista de qué hay, en qué orden sale en el menú y qué permiso
 * hace falta para verlo. Las RUTAS se generan a partir de esta misma tabla
 * (ver `app.routes.ts`) y no se escriben a mano en otro lado, y esa es toda
 * la gracia del asunto: añadir un módulo es AGREGAR UNA ENTRADA aquí, y es
 * imposible que el menú ofrezca algo que no tenga ruta o que la ruta exista
 * sin que el menú la ofrezca.
 *
 * El orden de los grupos es el del día de trabajo: lo que se usa todos los
 * días arriba, y lo que se abre una vez al mes abajo. Es una decisión de
 * la persona que usa esto, no de quien lo programa, y por eso la tabla está
 * en un archivo de un solo propósito y no escondida en el enrutador.
 */

import type { Type } from '@angular/core';

/** Un módulo al que se puede entrar. */
export interface Modulo {
  /** La ruta de la aplicación. Sin barra inicial. */
  ruta: string;
  etiqueta: string;
  /** Sin este permiso, el módulo no aparece y su ruta no abre. */
  permiso: string;
  /** Qué se va a hacer aquí. Lo lee el aviso de "pantalla pendiente". */
  pendiente: string;
  /** Nombre del icono SVG (sin extensión, coincide con archivo en assets/icons). */
  icon: string;
  /**
   * La pantalla del módulo, si ya existe.
   *
   * Opcional a propósito: sin esto sale la pantalla de "pendiente", y con
   * esto sale la de verdad. La tabla sigue siendo la única que decide qué
   * hay en el menú y qué ruta hay, y ahora ADEMÁS dice qué pantalla es la
   * de cada uno, sin abrir una lista aparte que se pueda olvidar.
   *
   * El import es dinámico y va dentro de la función, así que el código del
   * módulo se baja solo cuando se entra a él: poner aquí un
   * `import { Notas }` de arriba haría que la pantalla del mostrador
   * viajara en el paquete que descarga la auditoría.
   */
  carga?: () => Promise<Type<unknown>>;
}

/** Un grupo del menú lateral. El título no se puede filtrar. */
export interface Grupo {
  titulo: string;
  modulos: Modulo[];
  /** Si es true, el grupo se puede colapsar/expandir (para Sistema, etc.) */
  colapsable?: boolean;
  /** Si es true y colapsable, empieza colapsado */
  colapsadoPorDefecto?: boolean;
}

export const MENU: Grupo[] = [
  {
    titulo: 'Mostrador',
    modulos: [
      {
        ruta: 'notas',
        etiqueta: 'Notas de remisión',
        permiso: 'notas.ver',
        icon: 'clipboard',
        pendiente: 'Editar una nota ya capturada y reimprimir su PDF.',
        carga: () => import('../notas/notas').then((m) => m.Notas),
      },
    ],
  },
  {
    titulo: 'Catálogo',
    modulos: [
      {
        ruta: 'productos',
        etiqueta: 'Productos',
        permiso: 'productos.ver',
        icon: 'package',
        pendiente: 'Alta y edición de productos con su clave y unidad.',
        carga: () => import('../productos/productos').then((m) => m.Productos),
      },
      {
        ruta: 'categorias',
        etiqueta: 'Categorías',
        permiso: 'categorias.ver',
        icon: 'tag',
        pendiente: 'Categorías de producto y sus multiplicadores de rendimiento.',
        carga: () => import('../categorias/categorias').then((m) => m.Categorias),
      },
      {
        ruta: 'especies',
        etiqueta: 'Especies',
        permiso: 'especies.ver',
        icon: 'cow',
        pendiente: 'Especies de cliente (bovino, porcino, etc.) y su rendimiento.',
        carga: () => import('../especies/especies').then((m) => m.Especies),
      },
      {
        ruta: 'precios',
        etiqueta: 'Precios',
        permiso: 'precios.ver',
        icon: 'dollar-sign',
        pendiente: 'Listas de precios por especie y las vigencias.',
        carga: () => import('../precios/precios').then((m) => m.Precios),
      },
      {
        ruta: 'almacenes',
        etiqueta: 'Almacenes',
        permiso: 'almacenes.ver',
        icon: 'warehouse',
        pendiente: 'Las bodegas a donde entra la mercancía; las usa el alta de compras.',
        carga: () => import('../almacenes/almacenes').then((m) => m.Almacenes),
      },
    ],
  },
  {
    titulo: 'Clientes',
    modulos: [
      {
        ruta: 'clientes',
        etiqueta: 'Clientes',
        permiso: 'clientes.ver',
        icon: 'users',
        pendiente: 'Alta de clientes con su código, especie y datos fiscales.',
        carga: () => import('../clientes/clientes').then((m) => m.Clientes),
      },
    ],
  },
  {
    titulo: 'Abasto',
    modulos: [
      {
        ruta: 'proveedores',
        etiqueta: 'Proveedores',
        permiso: 'proveedores.ver',
        icon: 'truck',
        pendiente: 'Proveedores y sus folios de compra.',
        carga: () => import('../proveedores/proveedores').then((m) => m.Proveedores),
      },
      {
        ruta: 'compras',
        etiqueta: 'Compras',
        permiso: 'compras.ver',
        icon: 'download',
        pendiente: 'Registrar compras, entradas de mercancía y sus folios.',
        carga: () => import('../compras/compras').then((m) => m.Compras),
      },
      {
        ruta: 'inventario',
        etiqueta: 'Inventario',
        permiso: 'inventario.ver',
        icon: 'bar-chart',
        pendiente: 'Existencia por producto y los ajustes y mermas.',
        carga: () => import('../inventario/inventario').then((m) => m.Inventario),
      },
    ],
  },
  {
    titulo: 'Dinero',
    modulos: [
      {
        ruta: 'pagos',
        etiqueta: 'Pagos',
        permiso: 'pagos.ver',
        icon: 'credit-card',
        pendiente: 'Registrar pagos y aplicarlos a las notas abiertas.',
        carga: () => import('../pagos/pagos').then((m) => m.Pagos),
      },
      {
        ruta: 'estado-cuenta',
        etiqueta: 'Estado de cuenta',
        permiso: 'estado_cuenta.ver',
        icon: 'file-text',
        pendiente: 'Saldo por cliente y su hoja de estado de cuenta para cobrar.',
        carga: () => import('../estado-cuenta/estado-cuenta').then((m) => m.EstadoCuenta),
      },
    ],
  },
  {
    titulo: 'Sistema',
    colapsable: true,
    colapsadoPorDefecto: true,
    modulos: [
      {
        ruta: 'usuarios',
        etiqueta: 'Usuarios y roles',
        permiso: 'usuarios.ver',
        icon: 'user-cog',
        pendiente: 'Usuarios, roles y la clave de cada quien.',
        carga: () => import('../usuarios/usuarios').then((m) => m.Usuarios),
      },
      {
        ruta: 'auditoria',
        etiqueta: 'Auditoría',
        permiso: 'auditoria.ver',
        icon: 'scroll',
        pendiente: 'Las cinco bitácoras en solo lectura.',
        carga: () => import('../auditoria/auditoria').then((m) => m.Auditoria),
      },
      {
        ruta: 'reportes',
        etiqueta: 'Reportes',
        permiso: 'reportes.ver',
        icon: 'pie-chart',
        pendiente: 'Existencia, consumo semanal y estado de cuenta, en solo lectura.',
        carga: () => import('../reportes/reportes').then((m) => m.Reportes),
      },
      {
        ruta: 'caja',
        etiqueta: 'Caja y bancos',
        permiso: 'caja.ver',
        icon: 'bank',
        pendiente: 'Cuentas, movimientos de ingreso y egreso, y su resumen.',
        carga: () => import('../caja/caja').then((m) => m.Caja),
      },
    ],
  },
];

/** Todos los módulos, sin agrupar. Es lo que consume el enrutador. */
export const MODULOS: Modulo[] = MENU.flatMap((grupo) => grupo.modulos);

/**
 * Los grupos con lo que la persona SÍ puede ver.
 *
 * Un grupo que se queda sin módulos no se devuelve: es el caso de la cajera
 * con Catálogo, y dejar un "CATÁLOGO" con nada adentro es ruido que hace
 * dudar de si algo falló.
 */
export function menuPara(permisos: ReadonlySet<string>): Grupo[] {
  return MENU.map((grupo) => ({
    titulo: grupo.titulo,
    modulos: grupo.modulos.filter((modulo) => permisos.has(modulo.permiso)),
  })).filter((grupo) => grupo.modulos.length > 0);
}

/**
 * Los módulos del grupo "Sistema" que la persona puede ver.
 *
 * El grupo "Sistema" NO se dibuja en el menú lateral: su única puerta es el
 * desplegable de configuración de la barra. Por eso se expone aparte, para que
 * ese desplegable salga de la MISMA tabla y no de una copia escrita a mano que
 * se queda atrás cuando el catálogo gana un módulo. Con la copia, "Caja y
 * bancos" y "Reportes" existían como ruta pero no había forma de abrirlos.
 */
export function modulosSistema(permisos: ReadonlySet<string>): Modulo[] {
  const sistema = MENU.find((grupo) => grupo.titulo === 'Sistema');
  return (sistema?.modulos ?? []).filter((modulo) => permisos.has(modulo.permiso));
}

/**
 * A dónde va la persona al entrar: el primer módulo que puede ver.
 *
 * Se elige el primero y no uno "principal" porque el menú ya está ordenado
 * por uso, y además porque un módulo principal fijo por rol sería una
 * excepción más que mantener. Si no tiene ningún módulo, se devuelve `null`
 * y la aplicación le dice eso en vez de dejarlo en un callejón sin salida.
 */
export function primerModulo(permisos: ReadonlySet<string>): Modulo | null {
  return MODULOS.find((modulo) => permisos.has(modulo.permiso)) ?? null;
}

/** La ruta de inicio ya con la barra inicial, o `null` si no hay ninguna. */
export function rutaDeInicio(permisos: ReadonlySet<string>): string | null {
  const modulo = primerModulo(permisos);
  return modulo ? `/${modulo.ruta}` : null;
}
