/**
 * El catalogo de modulos de la app.
 *
 * Aqui esta la lista de que hay, en que orden sale en el menu y que permiso
 * hace falta para verlo. Las RUTAS se generan a partir de esta misma tabla
 * (ver `app.routes.ts`) y no se escriben a mano en otro lado, y esa es toda
 * la gracia del asunto: anadir un modulo es AGREGAR UNA ENTRADA aqui, y es
 * imposible que el menu ofrezca algo que no tenga ruta o que la ruta exista
 * sin que el menu la ofrezca.
 *
 * El orden de los grupos es el del dia de trabajo: lo que se usa todos los
 * dias arriba, y lo que se abre una vez al mes abajo. Es una decision de
 * la persona que usa esto, no del que lo programa, y por eso la tabla esta
 * en un archivo de un solo proposito y no escondida en el router.
 */

import type { Type } from '@angular/core';

/** Un modulo al que se puede entrar. */
export interface Modulo {
  /** La ruta de la app. Sin barra inicial. */
  ruta: string;
  etiqueta: string;
  /** Sin este permiso, el modulo no aparece y su ruta no abre. */
  permiso: string;
  /** Que se va a hacer aqui. Lo lee el aviso de "pantalla pendiente". */
  pendiente: string;
  /**
   * La pantalla del modulo, si ya existe.
   *
   * Opcional a proposito: sin esto sale la pantalla de "pendiente", y con
   * esto sale la de verdad. La tabla sigue siendo la unica que decide que
   * hay en el menu y que ruta hay, y ahora ADEMAS dice que pantalla es la
   * de cada uno, sin abrir una lista aparte que se pueda olvidar.
   *
   * El import es dinamico y va dentro de la funcion, asi que el codigo del
   * modulo se baja solo cuando se entra a el: poner aqui un
   * `import { Notas }` de arriba haria que la pantalla del mostrador
   * viajara en el bundle de la auditoria.
   */
  carga?: () => Promise<Type<unknown>>;
}

/** Un grupo del menu lateral. El titulo no se puede filtrar. */
export interface Grupo {
  titulo: string;
  modulos: Modulo[];
}

export const MENU: Grupo[] = [
  {
    titulo: 'Mostrador',
    modulos: [
      {
        ruta: 'notas',
        etiqueta: 'Notas de remision',
        permiso: 'notas.ver',
        pendiente: 'Editar una nota ya capturada y reimprimir su PDF.',
        carga: () => import('../notas/notas').then((m) => m.Notas),
      },
    ],
  },
  {
    titulo: 'Catalogo',
    modulos: [
      {
        ruta: 'productos',
        etiqueta: 'Productos',
        permiso: 'productos.ver',
        pendiente: 'Alta y edicion de productos con su clave y unidad.',
        carga: () => import('../productos/productos').then((m) => m.Productos),
      },
      {
        ruta: 'categorias',
        etiqueta: 'Categorias',
        permiso: 'categorias.ver',
        pendiente: 'Categorias de producto y sus multipliers de rendimiento.',
        carga: () => import('../categorias/categorias').then((m) => m.Categorias),
      },
      {
        ruta: 'especies',
        etiqueta: 'Especies',
        permiso: 'especies.ver',
        pendiente: 'Especies de cliente (bovino, porcino, etc.) y su rendimiento.',
        carga: () => import('../especies/especies').then((m) => m.Especies),
      },
      {
        ruta: 'precios',
        etiqueta: 'Precios',
        permiso: 'precios.ver',
        pendiente: 'Listas de precios por especie y las vigorencias.',
        carga: () => import('../precios/precios').then((m) => m.Precios),
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
        pendiente: 'Alta de clientes con su codigo, especie y datos fiscales.',
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
        pendiente: 'Proveedores y sus folios de compra.',
        carga: () => import('../proveedores/proveedores').then((m) => m.Proveedores),
      },
      {
        ruta: 'compras',
        etiqueta: 'Compras',
        permiso: 'compras.ver',
        pendiente: 'Registrar compras, entradas de mercancia y sus folios.',
        carga: () => import('../compras/compras').then((m) => m.Compras),
      },
      {
        ruta: 'inventario',
        etiqueta: 'Inventario',
        permiso: 'inventario.ver',
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
        pendiente: 'Registrar pagos y aplicarlos a las notas abiertas.',
        carga: () => import('../pagos/pagos').then((m) => m.Pagos),
      },
      {
        ruta: 'facturacion',
        etiqueta: 'Facturacion',
        permiso: 'facturas.ver',
        pendiente: 'Emitir facturas y ver las ya emitidas.',
        carga: () => import('../facturacion/facturacion').then((m) => m.Facturacion),
      },
      {
        ruta: 'caja',
        etiqueta: 'Caja y bancos',
        permiso: 'caja.ver',
        pendiente: 'Cuentas, movimientos de ingreso y egreso, y su resumen.',
        carga: () => import('../caja/caja').then((m) => m.Caja),
      },
    ],
  },
  {
    titulo: 'Sistema',
    modulos: [
      {
        ruta: 'usuarios',
        etiqueta: 'Usuarios y roles',
        permiso: 'usuarios.ver',
        pendiente: 'Usuarios, roles y la clave de cada quien.',
        carga: () => import('../usuarios/usuarios').then((m) => m.Usuarios),
      },
      {
        ruta: 'auditoria',
        etiqueta: 'Auditoria',
        permiso: 'auditoria.ver',
        pendiente: 'Las cinco bitacoras en solo lectura.',
      },
    ],
  },
];

/** Todos los modulos, sin agrupar. Es lo que consume el router. */
export const MODULOS: Modulo[] = MENU.flatMap((grupo) => grupo.modulos);

/**
 * Los grupos con lo que la persona SI puede ver.
 *
 * Un grupo que se queda sin modulos no se devuelve: es el caso de la
 * cajera, que no tiene nada de Sistema ni de Catalogo, y dejar un
 * "SISTEMA" con nada adentro es ruido que hace dudar de si algo fallo.
 */
export function menuPara(permisos: ReadonlySet<string>): Grupo[] {
  return MENU.map((grupo) => ({
    titulo: grupo.titulo,
    modulos: grupo.modulos.filter((modulo) => permisos.has(modulo.permiso)),
  })).filter((grupo) => grupo.modulos.length > 0);
}

/**
 * A donde va la persona al entrar: el primer modulo que puede ver.
 *
 * Se elige el primero y no uno "principal" porque el menu ya esta ordenado
 * por uso, y ademas porque un modulo principal fijo por rol seria una
 * excepcion mas que mantener. Si no tiene ningun modulo, se devuelve `null`
 * y la app le dice eso en vez de dejarlo en un callejon sin salida.
 */
export function primerModulo(permisos: ReadonlySet<string>): Modulo | null {
  return MODULOS.find((modulo) => permisos.has(modulo.permiso)) ?? null;
}

/** La ruta de inicio ya con la barra inicial, o `null` si no hay ninguna. */
export function rutaDeInicio(permisos: ReadonlySet<string>): string | null {
  const modulo = primerModulo(permisos);
  return modulo ? `/${modulo.ruta}` : null;
}
