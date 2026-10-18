import { describe, expect, it } from 'vitest';
import { NoEncontrado } from '../../src/core/errores.js';
import type { RolFila, UsuarioFila } from '../../src/modules/usuarios/modelo.js';
import {
  eliminarCuenta,
  generarCodigoBaja,
  solicitarCodigoBaja,
} from '../../src/modules/usuarios/servicio.js';
import { falsoCliente } from './ayuda/falsoCliente.js';

/**
 * La baja definitiva, sin base de datos.
 *
 * Lo que se prueba NO es el SQL (eso lo cubren las pruebas contra Postgres de
 * verdad) sino las DECISIONES: que borrar la propia cuenta sea un 422 y no un
 * 500, que a la dueña no se le pueda borrar, que una cuenta activa todavia no
 * se pueda eliminar, y que un codigo mal tecleado cuente el intento en vez de
 * pasar de largo.
 *
 * El envio del correo NO se prueba aqui: `solicitarCodigoBaja` solo sigue al
 * SMTP cuando pasa todos los candados, y aqui se llega justo hasta el candado
 * que lanza. Mandar un correo de verdad desde una prueba seria lento, fragil y
 * dependeria de la red.
 */

function fila(cambios: Partial<UsuarioFila> = {}): UsuarioFila {
  return {
    id: '7',
    nombre: 'Maria',
    apellido_paterno: 'Lopez',
    apellido_materno: null,
    rfc: 'LOPM900101HDR',
    email: 'maria@ejemplo.local',
    fecha_contratacion: new Date('2026-01-01T00:00:00Z'),
    puesto: null,
    activo: false,
    es_dueno: false,
    debe_cambiar_contrasena: false,
    intentos_fallidos: 0,
    bloqueado_hasta: null,
    ultimo_acceso: null,
    creado_en: new Date('2026-01-01T00:00:00Z'),
    actualizado_en: new Date('2026-01-01T00:00:00Z'),
    fondo_login: null,
    roles: [],
    ...cambios,
  };
}

const ADMIN: RolFila = {
  id: 1,
  nombre: 'Administrador',
  descripcion: 'Dueña del negocio',
  es_admin: true,
};

/** Todo el SQL que se mando, en un solo texto, para revisarlo con `toMatch`. */
const sqlDe = (consultas: { sql: string }[]): string => consultas.map((c) => c.sql).join('\n');

describe('generarCodigoBaja', () => {
  it('son siempre 6 digitos', () => {
    for (let i = 0; i < 300; i++) {
      expect(generarCodigoBaja()).toMatch(/^[0-9]{6}$/);
    }
  });

  it('no se repite seguido', () => {
    // Un generador roto (siempre el mismo) pasaria el formato pero no esto.
    const codigos = new Set(Array.from({ length: 200 }, () => generarCodigoBaja()));
    expect(codigos.size).toBe(200);
  });
});

describe('eliminarCuenta: candados', () => {
  it('no deja eliminar la propia cuenta', async () => {
    const db = falsoCliente();
    db.responder([fila({ id: '7' })]);

    await expect(eliminarCuenta(db.cliente, 7, 7, '000000')).rejects.toMatchObject({
      codigo: 'NO_SELF_ELIMINAR',
    });
  });

  it('no deja eliminar a la dueña', async () => {
    const db = falsoCliente();
    db.responder([fila({ es_dueno: true })]);

    await expect(eliminarCuenta(db.cliente, 1, 7, '000000')).rejects.toMatchObject({
      codigo: 'DUENO_INELIMINABLE',
    });
  });

  it('no deja eliminar una cuenta todavia activa', async () => {
    const db = falsoCliente();
    db.responder([fila({ activo: true })]);

    await expect(eliminarCuenta(db.cliente, 1, 7, '000000')).rejects.toMatchObject({
      codigo: 'CUENTA_ACTIVA',
    });
  });

  it('no deja eliminar al ultimo administrador activo', async () => {
    const db = falsoCliente();
    db.responder([fila({ roles: [ADMIN] })]);
    db.responder([{ total: 0 }]); // contarAdminsActivos

    await expect(eliminarCuenta(db.cliente, 1, 7, '000000')).rejects.toMatchObject({
      codigo: 'ULTIMO_ADMIN',
    });
  });

  it('el 404 del usuario que no existe sale antes de cualquier candado', async () => {
    const db = falsoCliente();
    db.responder([]);

    await expect(eliminarCuenta(db.cliente, 1, 99, '000000')).rejects.toBeInstanceOf(NoEncontrado);
  });
});

describe('eliminarCuenta: el codigo', () => {
  it('exige que primero se haya pedido un codigo', async () => {
    const db = falsoCliente();
    db.responder([fila()]);
    db.responder([]); // leerCodigoBaja: no hay ninguno

    await expect(eliminarCuenta(db.cliente, 1, 7, '000000')).rejects.toMatchObject({
      codigo: 'SIN_CODIGO',
    });
  });

  it('tira un codigo vencido y pide uno nuevo', async () => {
    const db = falsoCliente();
    db.responder([fila()]);
    db.responder([{ coincide: true, expirado: true, intentos: 0 }]);
    db.responderConCambios(1); // borrarCodigoBaja

    await expect(eliminarCuenta(db.cliente, 1, 7, '000000')).rejects.toMatchObject({
      codigo: 'CODIGO_EXPIRADO',
    });
    expect(sqlDe(db.consultas)).toMatch(/DELETE FROM usuarios_codigo_baja/);
  });

  it('suma el intento cuando el codigo no coincide', async () => {
    const db = falsoCliente();
    db.responder([fila()]);
    db.responder([{ coincide: false, expirado: false, intentos: 0 }]);
    db.responder([{ intentos: 1 }]); // sumarIntentoBaja

    await expect(eliminarCuenta(db.cliente, 1, 7, '111111')).rejects.toMatchObject({
      codigo: 'CODIGO_INCORRECTO',
    });
    // Lo que importa: el intento quedo contado, no se sumo en una transaccion
    // que despues se revierte al lanzar.
    expect(sqlDe(db.consultas)).toMatch(/UPDATE usuarios_codigo_baja/);
  });

  it('corta al llegar al tope de intentos y tira el codigo', async () => {
    const db = falsoCliente();
    db.responder([fila()]);
    db.responder([{ coincide: false, expirado: false, intentos: 4 }]);
    db.responder([{ intentos: 5 }]); // sumarIntentoBaja: llego al tope
    db.responderConCambios(1); // borrarCodigoBaja

    await expect(eliminarCuenta(db.cliente, 1, 7, '111111')).rejects.toMatchObject({
      codigo: 'CODIGO_AGOTADO',
    });
  });

  it('borra la cuenta con el codigo correcto', async () => {
    const db = falsoCliente();
    db.responder([fila()]);
    db.responder([{ coincide: true, expirado: false, intentos: 0 }]);
    db.responder([]); // BEGIN
    db.responderConCambios(1); // DELETE FROM usuarios
    db.responder([]); // COMMIT

    await expect(eliminarCuenta(db.cliente, 1, 7, '123456')).resolves.toBeUndefined();

    // El borrado tiene que ir en su transaccion: es lo que hace que el trigger
    // de auditoria entre en el mismo COMMIT.
    expect(sqlDe(db.consultas)).toMatch(/DELETE FROM usuarios WHERE id = \$1/);
    expect(sqlDe(db.consultas)).toMatch(/BEGIN/);
    expect(sqlDe(db.consultas)).toMatch(/COMMIT/);
  });

  it('si la cuenta ya se borro en otro lado, lo dice en vez de fingir exito', async () => {
    const db = falsoCliente();
    db.responder([fila()]);
    db.responder([{ coincide: true, expirado: false, intentos: 0 }]);
    db.responder([]); // BEGIN
    db.responderConCambios(0); // DELETE: no habia fila
    db.responder([]); // COMMIT

    await expect(eliminarCuenta(db.cliente, 1, 7, '123456')).rejects.toBeInstanceOf(NoEncontrado);
  });
});

describe('solicitarCodigoBaja: candados', () => {
  it('no manda codigo para la propia cuenta', async () => {
    const db = falsoCliente();
    db.responder([fila({ id: '7' })]);

    await expect(solicitarCodigoBaja(db.cliente, 7, 7)).rejects.toMatchObject({
      codigo: 'NO_SELF_ELIMINAR',
    });
  });

  it('no manda codigo si la cuenta esta activa', async () => {
    const db = falsoCliente();
    db.responder([fila({ activo: true })]);

    await expect(solicitarCodigoBaja(db.cliente, 1, 7)).rejects.toMatchObject({
      codigo: 'CUENTA_ACTIVA',
    });
  });

  it('no manda codigo si la cuenta no tiene correo', async () => {
    const db = falsoCliente();
    db.responder([fila({ email: null })]);

    await expect(solicitarCodigoBaja(db.cliente, 1, 7)).rejects.toMatchObject({
      codigo: 'SIN_CORREO',
    });
  });
});
