import { describe, expect, it } from 'vitest';
import { cuerpoDeCliente, type FormaCliente } from './clientes-api';

/**
 * El cuerpo del cliente: lo que se manda al backend.
 *
 * Es la prueba de que la pantalla no normaliza distinto que el esquema de
 * `clientes/esquemas.ts`: el codigo arriba en mayusculas y limpio, y los
 * opcionales vacios como `null` (la base prefiere "sin dato" a un string
 * de espacios).
 */

function forma(parcial: Partial<FormaCliente> = {}): FormaCliente {
  return {
    codigo_cliente: 'CL01',
    nombre: 'Rancho La Escondida',
    establo: '',
    especie_id: '',
    estatus: 'Activo',
    telefono: '',
    direccion: '',
    ...parcial,
  };
}

describe('el cuerpo del cliente', () => {
  it('lleva el codigo en mayusculas y sin espacios', () => {
    const cuerpo = cuerpoDeCliente(forma({ codigo_cliente: '  cl01  ' }));
    expect(cuerpo.codigo_cliente).toBe('CL01');
  });

  it('el nombre se manda limpio', () => {
    const cuerpo = cuerpoDeCliente(forma({ nombre: '  Rancho   ' }));
    expect(cuerpo.nombre).toBe('Rancho');
  });

  it('los opcionales en blanco son null, no strings vacios', () => {
    const cuerpo = cuerpoDeCliente(forma());
    expect(cuerpo.establo).toBeNull();
    expect(cuerpo.especie_id).toBeNull();
    expect(cuerpo.telefono).toBeNull();
    expect(cuerpo.direccion).toBeNull();
  });

  it('la especie elegida va como numero', () => {
    const cuerpo = cuerpoDeCliente(forma({ especie_id: '3' }));
    expect(cuerpo.especie_id).toBe(3);
  });

  it('respeta el estatus', () => {
    const cuerpo = cuerpoDeCliente(forma({ estatus: 'Inactivo' }));
    expect(cuerpo.estatus).toBe('Inactivo');
  });

  it('un opcional con texto se limpia pero no se vuelve null', () => {
    const cuerpo = cuerpoDeCliente(forma({ telefono: '  (614) 123-4567  ' }));
    expect(cuerpo.telefono).toBe('(614) 123-4567');
  });
});
