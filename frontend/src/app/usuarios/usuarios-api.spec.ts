import { describe, expect, it } from 'vitest';
import {
  ETIQUETA_ESTADO,
  cuerpoDeActualizacion,
  cuerpoDeUsuario,
  estadoDeCuenta,
  motivoDeCandado,
  nombreCompleto,
  rfcNormalizado,
  rfcValido,
  rolesEnLinea,
  rolesNormalizados,
  type FormaUsuario,
  type Rol,
  type Usuario,
} from './usuarios-api';

/** Un usuario de prueba, con todo listo para sobreescribir lo que haga falta. */
function usuario(extra: Partial<Usuario> = {}): Usuario {
  return {
    id: 7,
    nombre: 'Juan',
    apellido_paterno: 'Perez',
    apellido_materno: 'Lopez',
    rfc: 'PELA800101HDFRPN09',
    email: 'juan@ejemplo.mx',
    fecha_contratacion: '2020-01-01T00:00:00.000Z',
    puesto: 'Cajera',
    activo: true,
    es_dueno: false,
    debe_cambiar_contrasena: false,
    intentos_fallidos: 0,
    bloqueado_hasta: null,
    ultimo_acceso: null,
    creado_en: '2020-01-01T00:00:00.000Z',
    actualizado_en: '2020-01-01T00:00:00.000Z',
    roles: [],
    ...extra,
  };
}

/** La forma del editor, completa y valida. */
function forma(extra: Partial<FormaUsuario> = {}): FormaUsuario {
  return {
    nombre: '  Juan  ',
    apellido_paterno: ' Perez ',
    apellido_materno: ' Lopez ',
    rfc: ' pela800101hdf ',
    email: ' juan@ejemplo.mx ',
    puesto: ' Cajera ',
    fecha_contratacion: '2021-03-04',
    ...extra,
  };
}

// Los nombres y el orden son los que devuelve la API: el catalogo sale por
// `ORDER BY nombre` (`usuarios/repositorio.ts`), no por id.
const CATALOGO: Rol[] = [
  { id: 1, nombre: 'Administrador', descripcion: 'Dueña del negocio', es_admin: true },
  { id: 3, nombre: 'Cajera', descripcion: null, es_admin: false },
  { id: 2, nombre: 'Empleada', descripcion: null, es_admin: false },
];

// ------------------------------------------------------------------ el RFC

describe('el RFC', () => {
  it('se manda recortado y en mayusculas, que es como lo normaliza el servidor', () => {
    expect(rfcNormalizado('  pela800101hdf  ')).toBe('PELA800101HDF');
  });

  it('acepta tanto el de persona fisica (4+6+3) como el de moral (3+6+3)', () => {
    expect(rfcValido('PELA800101HDF')).toBe(true); // 13
    expect(rfcValido('AAA010101AAA')).toBe(true); // 12
  });

  it('acepta el & de las personas fisicas, que no es una L ni una S', () => {
    expect(rfcValido('PE&J800101HDF')).toBe(true);
  });

  it('acepta la Ñ, que en el RFC si es una Ñ y no una N acentuada', () => {
    expect(rfcValido('PEÑA800101HDF')).toBe(true);
  });

  it('rechaza lo que no cabe en 12 o 13 caracteres', () => {
    expect(rfcValido('PELA800101')).toBe(false);
    expect(rfcValido('')).toBe(false);
    expect(rfcValido('PELA800101HDFRPN09')).toBe(false);
  });

  it('rechaza los simbolos que no son parte del RFC', () => {
    expect(rfcValido('PEL-800101-HDF')).toBe(false);
    expect(rfcValido('PELA800101HD#')).toBe(false);
  });
});

// ---------------------------------------------------------------- los cuerpos

describe('el cuerpo del alta', () => {
  it('manda los nombres recortados y el RFC en mayusculas', () => {
    const cuerpo = cuerpoDeUsuario(forma(), [2]);
    expect(cuerpo.nombre).toBe('Juan');
    expect(cuerpo.apellido_paterno).toBe('Perez');
    expect(cuerpo.apellido_materno).toBe('Lopez');
    expect(cuerpo.rfc).toBe('PELA800101HDF');
  });

  it('manda los roles que se le dieron', () => {
    expect(cuerpoDeUsuario(forma(), [1, 3]).roles).toEqual([1, 3]);
  });

  it('manda la fecha solo si se escribio: vacia seria un 400 del regex', () => {
    expect(cuerpoDeUsuario(forma({ fecha_contratacion: '' }), [2])).not.toHaveProperty(
      'fecha_contratacion',
    );
  });

  it('convierte lo vacio en null y no manda cadenas vacias', () => {
    // `nullish()` admite null pero '' es un valor valido para un texto: lo
    // que se quiere decir con un campo en blanco es "no hay".
    const cuerpo = cuerpoDeUsuario(forma({ apellido_materno: '', email: '   ', puesto: '' }), [2]);
    expect(cuerpo.apellido_materno).toBeNull();
    expect(cuerpo.email).toBeNull();
    expect(cuerpo.puesto).toBeNull();
  });

  it('deja el correo tal cual, sin recortarlo de mas', () => {
    expect(cuerpoDeUsuario(forma({ email: ' juan@ejemplo.mx ' }), [2]).email).toBe(
      'juan@ejemplo.mx',
    );
  });
});

describe('el cuerpo de la edicion', () => {
  it('lleva solo los cinco campos que el esquema acepta', () => {
    // El RFC y el correo NO estan: no se editan. Mandarlos seria mandarlos
    // al vacio de la nada, porque el servicio los descarta.
    const cuerpo = cuerpoDeActualizacion(forma());
    expect(Object.keys(cuerpo).sort()).toEqual([
      'apellido_materno',
      'apellido_paterno',
      'nombre',
      'puesto',
    ]);
    expect(cuerpo).not.toHaveProperty('rfc');
    expect(cuerpo).not.toHaveProperty('email');
    expect(cuerpo).not.toHaveProperty('fecha_contratacion');
  });

  it('nunca sale vacio, porque el esquema rechaza el cuerpo sin campos', () => {
    const cuerpo = cuerpoDeActualizacion(forma());
    expect(Object.keys(cuerpo).length).toBeGreaterThan(0);
  });

  it('no manda el `activo`: la baja va en su propio PATCH desde la fila', () => {
    expect(cuerpoDeActualizacion(forma())).not.toHaveProperty('activo');
  });
});

// -------------------------------------------------------------------- los roles

describe('los roles', () => {
  it('los deja en el orden del catalogo, no en el que se marcaron', () => {
    expect(rolesNormalizados([2, 1], CATALOGO)).toEqual([1, 2]);
  });

  it('no repite un rol marcado dos veces', () => {
    expect(rolesNormalizados([3, 3, 3], CATALOGO)).toEqual([3]);
  });

  it('descarta un id que no esta en el catalogo, en vez de mandarlo al servidor', () => {
    expect(rolesNormalizados([3, 99], CATALOGO)).toEqual([3]);
  });

  it('devuelve la lista vacia si no hay ninguno, que el esquema no acepta', () => {
    // El boton se apaga antes de llegar aqui, pero la funcion no inventa.
    expect(rolesNormalizados([], CATALOGO)).toEqual([]);
  });
});

// -------------------------------------------------------------------- la cuenta

describe('el estado de la cuenta', () => {
  const ahora = new Date('2026-01-10T12:00:00.000Z');

  it('es "ok" para una cuenta activa y sin pendientes', () => {
    expect(estadoDeCuenta(usuario(), ahora)).toBe('ok');
  });

  it('avisa que debe cambiar la clave cuando el reseteo se la dejo marcada', () => {
    expect(estadoDeCuenta(usuario({ debe_cambiar_contrasena: true }), ahora)).toBe('debe_cambiar');
  });

  it('dice bloqueado mientras la fecha de bloqueo siga en el futuro', () => {
    const bloqueado = usuario({ bloqueado_hasta: '2026-01-10T12:00:01.000Z' });
    expect(estadoDeCuenta(bloqueado, ahora)).toBe('bloqueado');
  });

  it('ya no dice bloqueado cuando la fecha de bloqueo ya paso', () => {
    // El backend limpia el bloqueo al entrar bien, pero la fila puede venir
    // con la fecha puesta si nadie ha entrado desde entonces.
    const vencido = usuario({ bloqueado_hasta: '2026-01-09T12:00:00.000Z' });
    expect(estadoDeCuenta(vencido, ahora)).toBe('ok');
  });

  it('manda "inactivo" antes que "bloqueado", porque es lo que hay que arreglar', () => {
    const dadoDeBaja = usuario({
      activo: false,
      bloqueado_hasta: '2026-01-10T12:00:01.000Z',
    });
    expect(estadoDeCuenta(dadoDeBaja, ahora)).toBe('inactivo');
  });

  it('tiene una etiqueta para cada estado', () => {
    for (const estado of ['inactivo', 'bloqueado', 'debe_cambiar', 'ok'] as const) {
      expect(ETIQUETA_ESTADO[estado]).toBeTruthy();
    }
  });
});

// -------------------------------------------------------------------- los nombres

describe('los nombres', () => {
  it('junta los tres nombres', () => {
    expect(nombreCompleto(usuario())).toBe('Juan Perez Lopez');
  });

  it('no deja un espacio colgando cuando no hay apellido materno', () => {
    expect(nombreCompleto(usuario({ apellido_materno: null }))).toBe('Juan Perez');
  });

  it('pone los roles en una linea para la columna de la lista', () => {
    const conRoles = usuario({ roles: [CATALOGO[1], CATALOGO[2]] });
    expect(rolesEnLinea(conRoles)).toBe('Cajera, Empleada');
  });

  it('no inventa un texto de roles para quien no tiene ninguno', () => {
    expect(rolesEnLinea(usuario())).toBe('');
  });
});

// -------------------------------------------------------------------- los candados

describe('los candados de la cuenta', () => {
  it('no te deja desactivar a ti mismo, y lo dice', () => {
    const yo = usuario({ id: 7 });
    expect(motivoDeCandado('desactivar', yo, 7, true)).toBe(
      'No puedes desactivar tu propia cuenta.',
    );
  });

  it('te deja desactivar a otro', () => {
    expect(motivoDeCandado('desactivar', usuario({ id: 7 }), 3, true)).toBeNull();
  });

  it('no te deja quitarte a ti mismo el rol de administrador', () => {
    const yo = usuario({ id: 7 });
    expect(motivoDeCandado('quitar_admin', yo, 7, true)).toBe(
      'No puedes quitarte a ti mismo el rol de administrador.',
    );
  });

  it('te deja quitarle el admin a otro, siempre que quede alguien con el rol', () => {
    expect(motivoDeCandado('quitar_admin', usuario({ id: 7 }), 3, true)).toBeNull();
  });

  it('avisa cuando el cambio dejaria la base sin ningun administrador', () => {
    expect(motivoDeCandado('quitar_admin', usuario({ id: 7 }), 3, false)).toBe(
      'Tiene que quedar un administrador activo.',
    );
  });
});
