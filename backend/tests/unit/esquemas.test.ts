import { describe, expect, it } from 'vitest';
import {
  cambiarContrasenaEsquema,
  loginEsquema,
  mapearUsuario,
  type UsuarioFila,
} from '../../src/modules/auth/esquemas.js';
import {
  actualizarClienteEsquema,
  crearClienteEsquema,
  listarClientesEsquema,
} from '../../src/modules/clientes/esquemas.js';

/**
 * Pruebas de los esquemas de Zod: son la primera linea de defensa y son
 * logica pura, asi que corren en milisegundos sin base ni servidor.
 */

describe('loginEsquema', () => {
  it('acepta un correo y contrasena correctos', () => {
    const r = loginEsquema.parse({ correo: 'a@b.com', contrasena: 'x' });
    expect(r.correo).toBe('a@b.com');
  });

  it('recorta los espacios del correo', () => {
    const r = loginEsquema.parse({ correo: '  admin@ejemplo.local  ', contrasena: 'x' });
    expect(r.correo).toBe('admin@ejemplo.local');
  });

  it('acepta el correo en cualquier caja', () => {
    // No se normaliza a minusculas en Zod a proposito: la comparacion
    // case-insensitive la hace el SQL (lower(u.email) = lower($1)), y
    // duplicar esa logica aqui seria dos fuentes de verdad.
    const r = loginEsquema.parse({ correo: 'Admin@Ejemplo.LOCAL', contrasena: 'x' });
    expect(r.correo).toBe('Admin@Ejemplo.LOCAL');
  });

  it.each([
    ['correo sin arroba', 'admin.local', 'x'],
    ['correo vacio', '', 'x'],
    ['contrasena vacia', 'a@b.com', ''],
  ])('rechaza: %s', (_nombre, correo, contrasena) => {
    expect(() => loginEsquema.parse({ correo, contrasena })).toThrow();
  });
});

describe('politica de contrasena', () => {
  const valida = (nueva: string, actual = 'CAMBIAR-ESTA-CLAVE') =>
    cambiarContrasenaEsquema.safeParse({ actual, nueva });

  it('acepta una contrasena fuerte', () => {
    expect(valida('NuevaClaveSegura2026').success).toBe(true);
  });

  it.each([
    ['menos de 12 caracteres', 'Corta2026!A'],
    ['sin mayusculas', 'nuevaclavesegura2026'],
    ['sin minusculas', 'NUEVACLAVESEGURA2026'],
    ['sin numeros', 'NuevaClaveSegura'],
  ])('rechaza: %s', (_nombre, nueva) => {
    const r = valida(nueva);
    expect(r.success).toBe(false);
  });

  it('rechaza repetir la misma contrasena', () => {
    const r = cambiarContrasenaEsquema.safeParse({
      actual: 'NuevaClaveSegura2026',
      nueva: 'NuevaClaveSegura2026',
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      // El error tiene que senalar el campo nuevo, no el actual.
      expect(r.error.issues[0]?.path).toEqual(['nueva']);
    }
  });

  it('no filtra la contrasena en el mensaje de error', () => {
    const r = valida('corta');
    expect(r.success).toBe(false);
    if (!r.success) {
      const texto = JSON.stringify(r.error.issues);
      expect(texto).not.toContain('CAMBIAR-ESTA-CLAVE');
    }
  });
});

describe('listarClientesEsquema', () => {
  it('pone limites por defecto y sanea el offset', () => {
    const r = listarClientesEsquema.parse({});
    expect(r.limite).toBe(50);
    expect(r.offset).toBe(0);
  });

  it('convierte los query params de texto a numero', () => {
    // Asi es como llegan de verdad: en el query string todo es string.
    const r = listarClientesEsquema.parse({ limite: '10', offset: '20' });
    expect(r.limite).toBe(10);
    expect(r.offset).toBe(20);
  });

  it('acepta un limite alto pedido por el admin', () => {
    expect(listarClientesEsquema.safeParse({ limite: '200' }).success).toBe(true);
  });

  it('rechaza un limite absurdo', () => {
    expect(listarClientesEsquema.safeParse({ limite: '100000' }).success).toBe(false);
  });

  it('rechaza un limite negativo', () => {
    expect(listarClientesEsquema.safeParse({ limite: '-5' }).success).toBe(false);
  });
});

describe('crearClienteEsquema', () => {
  it('exige codigo y nombre', () => {
    expect(crearClienteEsquema.safeParse({}).success).toBe(false);
  });

  it('acepta el cliente minimo', () => {
    const r = crearClienteEsquema.parse({ codigo_cliente: 'C1', nombre: 'Granja Uno' });
    expect(r.codigo_cliente).toBe('C1');
  });

  it('recorta los espacios del nombre', () => {
    const r = crearClienteEsquema.parse({ codigo_cliente: 'C1', nombre: '  Granja Uno  ' });
    expect(r.nombre).toBe('Granja Uno');
  });

  it('acepta un cliente sin rfc y lo deja en null', () => {
    const r = crearClienteEsquema.parse({ codigo_cliente: 'C1', nombre: 'Granja Uno' });
    expect(r.rfc).toBeNull();
  });

  it('un rfc en blanco tambien significa "sin dato"', () => {
    const r = crearClienteEsquema.parse({ codigo_cliente: 'C1', nombre: 'G', rfc: '   ' });
    expect(r.rfc).toBeNull();
  });

  it('pone el rfc en mayusculas antes de validarlo', () => {
    const r = crearClienteEsquema.parse({
      codigo_cliente: 'C1',
      nombre: 'G',
      rfc: '  xaxx010101000 ',
    });
    expect(r.rfc).toBe('XAXX010101000');
  });

  it('rechaza un rfc que no cumple el formato del SAT', () => {
    const r = crearClienteEsquema.safeParse({ codigo_cliente: 'C1', nombre: 'G', rfc: '12345' });
    expect(r.success).toBe(false);
  });
});

describe('actualizarClienteEsquema', () => {
  it('la clave rfc ausente no se inventa: no es lo mismo que borrarlo', () => {
    const r = actualizarClienteEsquema.parse({ nombre: 'Otro nombre' });
    expect('rfc' in r).toBe(false);
  });

  it('el rfc vacio llega como null, que es lo que borra el dato fiscal', () => {
    const r = actualizarClienteEsquema.parse({ rfc: '' });
    expect(r.rfc).toBeNull();
  });
});

describe('mapearUsuario', () => {
  const fila: UsuarioFila = {
    id: '7',
    nombre: 'Administrador',
    email: 'admin@ejemplo.local',
    activo: true,
    debe_cambiar_contrasena: true,
    puesto: 'Dueño',
    contrasena_ok: true,
    permisos: null,
    roles: null,
  };

  it('convierte el id de texto a numero', () => {
    // pg devuelve los bigint como string para no perder precision con
    // JS. Si aqui no se convierte, el JSON llevaria "7" y no 7.
    expect(mapearUsuario(fila).id).toBe(7);
  });

  it('renombra los campos a camelCase para el frontend', () => {
    const u = mapearUsuario(fila);
    expect(u.debeCambiarContrasena).toBe(true);
    expect(u).not.toHaveProperty('debe_cambiar_contrasena');
  });

  it('no expone la contrasena ni su hash', () => {
    const u = mapearUsuario(fila) as unknown as Record<string, unknown>;
    expect(u).not.toHaveProperty('contrasena');
    expect(u).not.toHaveProperty('contrasena_ok');
    expect(u).not.toHaveProperty('activo');
  });
});
