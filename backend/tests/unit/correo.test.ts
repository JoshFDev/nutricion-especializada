import { describe, expect, it, vi } from 'vitest';

const { crearTransporte } = vi.hoisted(() => ({
  crearTransporte: vi.fn(() => ({ sendMail: vi.fn() })),
}));

vi.mock('nodemailer', () => ({
  default: { createTransport: crearTransporte },
}));

import { obtenerTransporter } from '../../src/core/correo.js';

/**
 * Los limites del SMTP.
 *
 * Sin ellos, nodemailer puede esperar minutos a que el servidor de correo
 * conteste. El ticket de una nota es un extra: si el SMTP esta caido, la
 * venta ya se guardo y la peticion no puede quedarse esperando.
 */
describe('obtenerTransporter', () => {
  it('configura tiempos de espera acotados', () => {
    obtenerTransporter();

    expect(crearTransporte).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 30_000,
      }),
    );
  });
});
