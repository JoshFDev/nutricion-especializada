import { describe, expect, it } from 'vitest';
import * as repo from '../../src/modules/auth/repositorio.js';
import { falsoCliente } from './ayuda/falsoCliente.js';

/**
 * La limpieza de sesiones del arranque.
 *
 * El caso que se quiere fijar es el de las sesiones EXPIRADAS que nadie
 * cerro: el middleware las rechaza, pero sin borrarlas se quedan en la
 * tabla para siempre.
 */
describe('auth.repositorio.podarSesiones', () => {
  it('borra las cerradas antiguas y las expiradas que siguen abiertas', async () => {
    const db = falsoCliente().responderConCambios(4);

    const borradas = await repo.podarSesiones(db.cliente, 30);

    expect(borradas).toBe(4);
    const sql = db.consultas[0]?.sql ?? '';
    expect(sql).toContain('cerrada_en IS NOT NULL');
    expect(sql).toContain('cerrada_en IS NULL');
    expect(sql).toContain('expira_en < now()');
  });
});
