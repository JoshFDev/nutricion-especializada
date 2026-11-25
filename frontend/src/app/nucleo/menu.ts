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
  /**
   * Para qué sirve el módulo, en una línea, para la Ayuda.
   *
   * Va aparte de `pendiente` a propósito: `pendiente` describe lo que le
   * FALTA a la pantalla, y eso deja de ser cierto en cuanto la pantalla
   * existe. `ayuda` describe lo que la pantalla HACE, y sigue siendo cierto.
   * Es obligatorio para que la guía no se quede con un módulo en blanco
   * cuando se agrega uno nuevo.
   */
  ayuda: string;
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
        pendiente: 'Editar una nota ya guardada y volver a imprimirla.',
        ayuda:
          'Haz las ventas del día: elige al cliente, agrega los productos y guarda. Después puedes imprimir o cancelar la nota.',
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
        pendiente: 'Dar de alta productos y cambiar sus datos.',
        ayuda: 'Lo que vendes: nombre, clave, presentación y si está disponible.',
        carga: () => import('../productos/productos').then((m) => m.Productos),
      },
      {
        ruta: 'categorias',
        etiqueta: 'Categorías',
        permiso: 'categorias.ver',
        icon: 'tag',
        pendiente: 'Crear grupos de productos.',
        ayuda: 'Los grupos que usamos para ordenar los productos y encontrarlos más rápido.',
        carga: () => import('../categorias/categorias').then((m) => m.Categorias),
      },
      {
        ruta: 'especies',
        etiqueta: 'Especies',
        permiso: 'especies.ver',
        icon: 'cow',
        pendiente: 'Crear los tipos de cliente o animal.',
        ayuda: 'Los tipos de cliente o animal (bovino, porcino y otros) que se usan para poner el precio.',
        carga: () => import('../especies/especies').then((m) => m.Especies),
      },
      {
        ruta: 'precios',
        etiqueta: 'Precios',
        permiso: 'precios.ver',
        icon: 'dollar-sign',
        pendiente: 'Cambiar precios y fechas en que empiezan a valer.',
        ayuda: 'Lo que cuesta cada producto. Puedes tener un precio general y otro para un cliente especial.',
        carga: () => import('../precios/precios').then((m) => m.Precios),
      },
      {
        ruta: 'almacenes',
        etiqueta: 'Almacenes',
        permiso: 'almacenes.ver',
        icon: 'warehouse',
        pendiente: 'Los lugares donde se guarda la mercancía que compras.',
        ayuda: 'Los lugares donde se guarda la mercancía. El administrador los da de alta una sola vez y las compras los usan solitos.',
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
        pendiente: 'Dar de alta clientes y consultar lo que deben.',
        ayuda: 'La lista de tus clientes con su código, su tipo de animal y sus datos para facturar. Aquí también ves y ajustas lo que te deben.',
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
        pendiente: 'Dar de alta a quienes te venden y revisar sus compras.',
        ayuda: 'Quienes te venden la mercancía. Aquí los registras y consultas las compras que les haces.',
        carga: () => import('../proveedores/proveedores').then((m) => m.Proveedores),
      },
      {
        ruta: 'compras',
        etiqueta: 'Compras',
        permiso: 'compras.ver',
        icon: 'download',
        pendiente: 'Anotar la mercancía que entra y guardar su folio.',
        ayuda: 'Anota lo que compras y entra al almacén. Al guardar, el inventario se aumenta solito.',
        carga: () => import('../compras/compras').then((m) => m.Compras),
      },
      {
        ruta: 'inventario',
        etiqueta: 'Inventario',
        permiso: 'inventario.ver',
        icon: 'bar-chart',
        pendiente: 'Contar lo que hay y anotar lo que se daña o se corrige.',
        ayuda: 'Cuánto producto hay en el almacén. Aquí corriges el conteo o anotas lo que se dañó o caducó.',
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
        pendiente: 'Anotar los abonos que entregan los clientes.',
        ayuda: 'Anota lo que te pagan los clientes y aplícalo a sus notas pendientes. Lo que sobre queda como abono para la siguiente nota.',
        carga: () => import('../pagos/pagos').then((m) => m.Pagos),
      },
      {
        ruta: 'estado-cuenta',
        etiqueta: 'Estado de cuenta',
        permiso: 'estado_cuenta.ver',
        icon: 'file-text',
        pendiente: 'Consultar cuánto debe cada cliente e imprimir su cuenta.',
        ayuda: 'Mira cuánto debe cada cliente e imprime su estado de cuenta para ir a cobrar.',
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
        pendiente: 'Crear cuentas y elegir qué puede hacer cada persona.',
        ayuda: 'Las cuentas de quienes usan el sistema y lo que cada uno puede hacer. Aquí cambias tu contraseña.',
        carga: () => import('../usuarios/usuarios').then((m) => m.Usuarios),
      },
      {
        ruta: 'auditoria',
        etiqueta: 'Auditoría',
        permiso: 'auditoria.ver',
        icon: 'scroll',
        pendiente: 'Consultar el registro de lo que se ha hecho.',
        ayuda: 'El registro de lo que se ha hecho en el sistema. Solo se puede mirar, no se puede cambiar.',
        carga: () => import('../auditoria/auditoria').then((m) => m.Auditoria),
      },
      {
        ruta: 'respaldos',
        etiqueta: 'Respaldos',
        permiso: 'respaldos.ver',
        icon: 'database',
        pendiente: 'Copias de seguridad para no perder los datos.',
        ayuda: 'Copias de seguridad de todo el sistema. Crea una, guárdala en otro lugar en JSON o SQL y tráela de vuelta cuando lo necesites.',
        carga: () => import('../respaldos/respaldos').then((m) => m.Respaldos),
      },
      {
        ruta: 'caja',
        etiqueta: 'Caja y bancos',
        permiso: 'caja.ver',
        icon: 'bank',
        pendiente: 'Anotar el dinero que entra y sale de caja y bancos.',
        ayuda: 'Tu caja y tus bancos: lo que entra, lo que sale y cuánto dinero hay disponible.',
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
 * bancos" existía como ruta pero no había forma de abrirlo.
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
