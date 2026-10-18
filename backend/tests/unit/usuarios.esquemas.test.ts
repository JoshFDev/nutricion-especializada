import { describe, expect, it } from 'vitest';
import { generarContrasenaTemporal } from '../../src/modules/usuarios/servicio.js';
import {
  actualizarUsuarioEsquema,
  codigoBajaEsquema,
  crearUsuarioEsquema,
  listarUsuariosEsquema,
} from '../../src/modules/usuarios/esquemas.js';

/**
 * Pruebas de la parte que NO necesita base de datos.
 *
 * Aqui van las dos cosas que conviene revisar a ojo: que la contrasena
 * temporal siempre sea valida, y que el RFC se exija con el formato del
 * SAT. El resto de las reglas (candados de administrador) si dependen del
 * estado de la base y se prueban en tests/api.test.mjs contra Postgres de
 * verdad.
 */

describe('generarContrasenaTemporal', () => {
  it('respeta el largo pedido', () => {
    for (const largo of [12, 16, 24, 40]) {
      expect(generarContrasenaTemporal(largo)).toHaveLength(largo);
    }
  });

  it('siempre trae mayuscula, minuscula, numero y simbolo', () => {
    // 200samples: si la garantia de forma estuviera rota, con menos
    // muestras pasaria sin que nadie se entere.
    for (let i = 0; i < 200; i++) {
      const clave = generarContrasenaTemporal();
      expect(clave, `sin mayuscula: ${clave}`).toMatch(/[A-Z]/);
      expect(clave, `sin minuscula: ${clave}`).toMatch(/[a-z]/);
      expect(clave, `sin numero: ${clave}`).toMatch(/[0-9]/);
      expect(clave, `sin simbolo: ${clave}`).toMatch(/[!#$%&*?]/);
    }
  });

  it('nunca trae caracteres que se confunden al leerla', () => {
    // 0 contra O, 1 contra l o I. El administrador la va a dictar por
    // telefono, asi que esto no es cosmetico.
    for (let i = 0; i < 200; i++) {
      expect(generarContrasenaTemporal()).not.toMatch(/[O0lI1]/);
    }
  });

  it('no se repite seguido', () => {
    const claves = new Set(Array.from({ length: 200 }, () => generarContrasenaTemporal()));
    expect(claves.size).toBe(200);
  });
});

describe('esquema de alta', () => {
  const base = {
    nombre: 'Maria',
    apellido_paterno: 'Hernandez',
    rfc: 'GODL900101HDR',
  };

  it('acepta un RFC valido de 12 y de 13 caracteres', () => {
    // 3 letras + 6 digitos + 3 alfanumericos = 12
    expect(crearUsuarioEsquema.parse({ ...base, rfc: 'GOD900101HDR' }).rfc).toBe('GOD900101HDR');
    // 4 letras + 6 digitos + 3 alfanumericos = 13
    expect(crearUsuarioEsquema.parse(base).rfc).toBe('GODL900101HDR');
  });

  it('sube el RFC a mayusculas', () => {
    expect(crearUsuarioEsquema.parse({ ...base, rfc: 'godl900101hdr' }).rfc).toBe('GODL900101HDR');
  });

  it('acepta un correo con espacios de mas y lo recorta', () => {
    // Misma regla que la edicion: recortar ANTES de comprobar el formato, o un
    // correo pegado desde otro lado se rechazaria por "formato invalido".
    expect(crearUsuarioEsquema.parse({ ...base, email: '  a@b.com  ' }).email).toBe('a@b.com');
  });

  it('acepta el & del RFC de persona fisica moral', () => {
    expect(crearUsuarioEsquema.parse({ ...base, rfc: '&AMP900101HDR' }).rfc).toBe('&AMP900101HDR');
  });

  it.each([
    ['muy corto', 'GOD9001'],
    ['muy largo', 'GODL900101HDRXX'],
    ['con guion', 'GODL-900101-HDR'],
    ['con espacios', 'GODL 900101 HDR'],
    ['letras en la parte de la fecha', 'GODLAB0101HDR'],
    ['vacio', ''],
  ])('rechaza un RFC %s', (_caso, rfc) => {
    expect(crearUsuarioEsquema.safeParse({ ...base, rfc }).success).toBe(false);
  });

  it('exige al menos un rol', () => {
    expect(crearUsuarioEsquema.safeParse({ ...base, roles: [] }).success).toBe(false);
    expect(crearUsuarioEsquema.safeParse({ ...base, roles: [2] }).success).toBe(true);
  });

  it('asigna el rol Cajera si no le dicen cual', () => {
    // Default razonable: alta rapida para el caso comun.
    expect(crearUsuarioEsquema.parse(base).roles).toEqual([2]);
  });

  it('rechaza campos que el cliente no deberia mandar', () => {
    // El schema es estricto a proposito: si alguien manda es_dueno o id,
    // que se entere con un 400 en vez de que el campo se ignore en
    // silencio y el usuario descubra meses despues que no hizo nada.
    const conEsDueño = crearUsuarioEsquema.safeParse({ ...base, es_dueno: true });
    expect(conEsDueño.success).toBe(false);

    const conId = crearUsuarioEsquema.safeParse({ ...base, id: 1 });
    expect(conId.success).toBe(false);
  });
});

describe('contrasena elegida en el alta', () => {
  const base = {
    nombre: 'Maria',
    apellido_paterno: 'Hernandez',
    rfc: 'GODL900101HDR',
  };

  it('se acepta si cumple la politica fuerte', () => {
    const clave = 'Remilton2026';
    const d = crearUsuarioEsquema.parse({ ...base, contrasena: clave });
    expect(d.contrasena).toBe(clave);
  });

  it('si no viene, el alta sigue siendo valida', () => {
    // Es el camino viejo: el servicio genera la temporal. No se rompe.
    expect(crearUsuarioEsquema.parse(base).contrasena).toBeUndefined();
  });

  /*
   * Estas cuatro son la razon de que el campo exista con validacion propia.
   * Cada una es una clave que el sistema iba a ACEPTAR en el alta y luego
   * RECHAZAR en el cambio de clave, dejando al usuario dado de alta con una
   * contrasena que el sistema no reconoce: no puede ni entrar ni cambiarla.
   */
  it.each([
    ['muy corta', 'Corta1a'],
    ['sin numero', 'RemiltonDosMil'],
    ['sin mayuscula', 'remilton2026x'],
    ['sin minuscula', 'REMILTON2026X'],
  ])('rechaza una contrasena %s', (_caso, clave) => {
    expect(crearUsuarioEsquema.safeParse({ ...base, contrasena: clave }).success).toBe(false);
  });

  it('no recorta los espacios: la clave es la que se teclea', () => {
    // Con .trim() la clave de la base seria distinta de la que escribe la
    // persona y no entraria nunca. Aqui se comprueba que NO hay trim.
    const clave = '  ConEspacios2026  ';
    expect(crearUsuarioEsquema.parse({ ...base, contrasena: clave }).contrasena).toBe(clave);
  });
});

describe('esquema de la edicion', () => {
  it('acepta el correo y lo recorta antes de validar el formato', () => {
    // El orden importa: `z.email().trim()` comprueba el formato ANTES de
    // recortar, y un correo pegado con espacios se rechazaria. Se recorta
    // primero, igual que en el login.
    expect(actualizarUsuarioEsquema.parse({ email: '  juan@ejemplo.mx  ' }).email).toBe(
      'juan@ejemplo.mx',
    );
  });

  it('deja el correo en null cuando se manda null: es "sin correo"', () => {
    expect(actualizarUsuarioEsquema.parse({ email: null }).email).toBeNull();
  });

  it('no toca el correo si no viene en el cuerpo', () => {
    expect(actualizarUsuarioEsquema.parse({ nombre: 'Maria' })).not.toHaveProperty('email');
  });

  it.each([
    ['sin arroba', 'juan.ejemplo.mx'],
    ['sin dominio', 'juan@'],
    ['vacio', ''],
  ])('rechaza un correo %s', (_caso, email) => {
    expect(actualizarUsuarioEsquema.safeParse({ email }).success).toBe(false);
  });
});

describe('esquema del codigo de baja', () => {
  it('acepta exactamente 6 digitos', () => {
    expect(codigoBajaEsquema.parse({ codigo: '042198' }).codigo).toBe('042198');
  });

  it('recorta los espacios de los lados', () => {
    expect(codigoBajaEsquema.parse({ codigo: '  042198  ' }).codigo).toBe('042198');
  });

  it.each([
    ['muy corto', '12345'],
    ['muy largo', '1234567'],
    ['con letras', '12345a'],
    ['con espacios adentro', '12 34 56'],
    ['vacio', ''],
  ])('rechaza un codigo %s', (_caso, codigo) => {
    expect(codigoBajaEsquema.safeParse({ codigo }).success).toBe(false);
  });

  it('rechaza campos que el cliente no deberia mandar', () => {
    expect(codigoBajaEsquema.safeParse({ codigo: '123456', id: 7 }).success).toBe(false);
  });
});

describe('esquema de listado', () => {
  it('pone limites razonables por defecto', () => {
    const q = listarUsuariosEsquema.parse({});
    expect(q.limite).toBe(50);
    expect(q.offset).toBe(0);
  });

  it('convierte activo=true/false a booleano', () => {
    expect(listarUsuariosEsquema.parse({ activo: 'true' }).activo).toBe(true);
    expect(listarUsuariosEsquema.parse({ activo: 'false' }).activo).toBe(false);
  });

  it('rechaza un limite enorme', () => {
    // Sin tope, un ?limite=999999000 se come la memoria del proceso.
    expect(listarUsuariosEsquema.safeParse({ limite: 999999 }).success).toBe(false);
  });
});
