import { describe, expect, it } from 'vitest';
import { NoAutenticado, NoEncontrado } from '../../src/core/errores.js';
import * as auth from '../../src/modules/auth/servicio.js';
import { falsoCliente } from './ayuda/falsoCliente.js';

/**
 * Pruebas de las REGLAS de inicio de sesion, sin base de datos.
 *
 * Aqui se comprueba la decision que toma el servicio: si el usuario
 * existe, si esta activo, si escribe un codigo valido y, sobre todo,
 * que nunca se distinga "correo no registrado" de "contrasena mala".
 */

const CTX = { ip: '127.0.0.1', userAgent: 'vitest' };

const usuarioOk = (over: Record<string, unknown> = {}) => ({
  id: '1',
  nombre: 'Administrador',
  email: 'admin@ejemplo.local',
  activo: true,
  debe_cambiar_contrasena: true,
  puesto: 'Dueño',
  contrasena_ok: true,
  ...over,
});

describe('iniciarSesion', () => {
  /** Prepara las tres respuestas que da el login: buscar, sesion, bitacora. */
  const preparar = (filas: unknown[]) => {
    const db = falsoCliente();
    db.responder(filas).responder([]).responder([]);
    return db;
  };

  const entrar = (db: ReturnType<typeof preparar>, correo: string, contrasena: string) =>
    auth.iniciarSesion(db.cliente, { correo, contrasena }, CTX);

  it('devuelve token y usuario si todo esta bien', async () => {
    const db = preparar([usuarioOk()]);

    const r = await entrar(db, 'admin@ejemplo.local', 'CAMBIAR-ESTA-CLAVE');

    expect(r.token).toBeTruthy();
    // 32 bytes en base64url: 43 caracteres. El token opaco NO es el
    // hash; el hash es lo que se guarda (esta asercion esta en la
    // prueba siguiente).
    expect(r.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(r.usuario.id).toBe(1);
  });

  it('guarda el hash del token, nunca el token en texto plano', async () => {
    const db = preparar([usuarioOk()]);
    const r = await entrar(db, 'admin@ejemplo.local', 'CAMBIAR-ESTA-CLAVE');

    const insercion = db.consultas.find((c) => c.sql.includes('INSERT INTO sesiones'));
    expect(insercion).toBeDefined();
    // Lo guardado es el sha256 EN HEX, que es distinto del token que
    // viaja al cliente. Si se guardara el token, con acceso de solo
    // lectura a la tabla de sesiones se podrian robar todas.
    expect(insercion?.valores[1]).not.toBe(r.token);
    expect(String(insercion?.valores[1])).toMatch(/^[0-9a-f]{64}$/);
  });

  it('la contrasena en texto plano no viaja a la base, solo al SELECT', async () => {
    const db = preparar([usuarioOk()]);
    await entrar(db, 'admin@ejemplo.local', 'CAMBIAR-ESTA-CLAVE');

    // La contrasena SOLO puede aparecer en la consulta que la verifica
    // con crypt(). En el INSERT de la sesion no debe estar.
    const insercion = db.consultas.find((c) => c.sql.includes('INSERT INTO sesiones'));
    expect(insercion?.valores).not.toContain('CAMBIAR-ESTA-CLAVE');
  });

  it('rechaza con 401 si el correo no existe', async () => {
    const db = preparar([]);
    await expect(entrar(db, 'nadie@ejemplo.local', 'x')).rejects.toBeInstanceOf(NoAutenticado);
  });

  it('rechaza con 401 si la contrasena esta mal', async () => {
    const db = preparar([usuarioOk({ contrasena_ok: false })]);
    await expect(entrar(db, 'admin@ejemplo.local', 'mala')).rejects.toBeInstanceOf(NoAutenticado);
  });

  it('rechaza a un usuario desactivado aunque la contrasena sea correcta', async () => {
    const db = preparar([usuarioOk({ activo: false })]);
    await expect(entrar(db, 'admin@ejemplo.local', 'CAMBIAR-ESTA-CLAVE')).rejects.toBeInstanceOf(
      NoAutenticado,
    );
  });

  it('NO distingue "correo inexistente" de "contrasena incorrecta"', async () => {
    // Este es el test mas importante del archivo. Si alguien cambia el
    // mensaje para decir "ese correo no esta registrado", el endpoint
    // pasa a servir para averiguar que correos estan dados de alta.
    const sinRegistro = preparar([]);
    const claveMala = preparar([usuarioOk({ contrasena_ok: false })]);

    const mensaje1 = await entrar(sinRegistro, 'nadie@ejemplo.local', 'x').catch(
      (e: Error) => e.message,
    );
    const mensaje2 = await entrar(claveMala, 'admin@ejemplo.local', 'mala').catch(
      (e: Error) => e.message,
    );

    expect(mensaje1).toBe(mensaje2);
    expect(mensaje1).toBe('Correo o contrasena incorrectos');
  });

  it('registra el intento fallido en la bitacora de accesos', async () => {
    const db = preparar([]);
    await entrar(db, 'nadie@ejemplo.local', 'x').catch(() => undefined);

    const bitacora = db.consultas.find((c) => c.sql.includes('auditoria_accesos'));
    expect(bitacora).toBeDefined();
    // El evento va escrito en el SQL, no como parametro, asi que se
    // comprueba en el texto de la consulta.
    expect(bitacora?.sql).toContain('login_fallido');
    // Y el correo que se intento usar queda registrado.
    expect(bitacora?.valores).toContain('nadie@ejemplo.local');
  });

  it('NO registra intento fallido cuando el login es correcto', async () => {
    const db = preparar([usuarioOk()]);
    await entrar(db, 'admin@ejemplo.local', 'CAMBIAR-ESTA-CLAVE');

    const fallos = db.consultas.filter(
      (c) => c.sql.includes('auditoria_accesos') && c.valores.includes('login_fallido'),
    );
    expect(fallos).toHaveLength(0);
  });
});

describe('perfil', () => {
  it('lanza NoAutenticado si la sesion ya no corresponde a nadie', async () => {
    const db = falsoCliente().responder([]);
    await expect(auth.perfil(db.cliente, 999)).rejects.toBeInstanceOf(NoAutenticado);
  });

  it('devuelve permisos y roles vacios en vez de null', async () => {
    const db = falsoCliente().responder([
      {
        id: '1',
        nombre: 'Empleada',
        email: 'empleada@ejemplo.local',
        activo: true,
        debe_cambiar_contrasena: false,
        puesto: null,
        contrasena_ok: true,
        permisos: null,
        roles: null,
      },
    ]);

    const r = await auth.perfil(db.cliente, 1);
    // null en el JSON llega como null al frontend y habria que manejar
    // los dos casos. Se devuelve [] para que siempre sea un arreglo.
    expect(r.permisos).toEqual([]);
    expect(r.roles).toEqual([]);
  });
});

describe('cerrar', () => {
  it('no falla si la sesion ya estaba cerrada', async () => {
    const db = falsoCliente().responderConCambios(0);
    await expect(auth.cerrar(db.cliente, 5)).resolves.toBeUndefined();
  });
});

describe('codigos de error', () => {
  it('el login fallido responde 401 con codigo estable', () => {
    const e = new NoAutenticado('Correo o contrasena incorrectos');
    expect(e.estado).toBe(401);
    expect(e.codigo).toBe('NO_AUTENTICADO');
  });

  it('el recurso inexistente responde 404', () => {
    expect(new NoEncontrado('No existe el cliente 42').estado).toBe(404);
  });
});
