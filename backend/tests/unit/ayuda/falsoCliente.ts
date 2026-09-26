import type { PoolClient, QueryResult } from 'pg';

/**
 * Doble de prueba para un PoolClient.
 *
 * Por que sirve: los servicios reciben el cliente como parametro, no lo
 * piden al pool por su cuenta. Eso permite probarlos SIN base de datos
 * pasando un objeto que solo implementa `query`. Las reglas de negocio
 * se ejecutan de verdad; lo unico que se falsea es la respuesta de
 * Postgres.
 *
 * Es la ventaja concreta de haber separado las capas: sin esto, probar
 * una regla obligaria a levantar el servidor y la base.
 */

export interface ConsultaRegistrada {
  sql: string;
  valores: unknown[];
}

export interface FalsoCliente {
  cliente: PoolClient;
  consultas: ConsultaRegistrada[];
  /** Encola la respuesta de la siguiente llamada a query(). */
  responder(filas: unknown[]): FalsoCliente;
  /** Encola un error para la siguiente llamada a query(). */
  fallar(error: Error): FalsoCliente;
  /** Encola un resultado con rowCount, para los UPDATE/DELETE. */
  responderConCambios(cambios: number): FalsoCliente;
}

export function falsoCliente(): FalsoCliente {
  const consultas: ConsultaRegistrada[] = [];
  const cola: (() => Promise<QueryResult>)[] = [];

  const dbl: FalsoCliente = {
    cliente: undefined as unknown as PoolClient,
    consultas,

    responder(filas) {
      cola.push(() =>
        Promise.resolve({
          rows: filas,
          rowCount: filas.length,
          command: 'SELECT',
          oid: 0,
          fields: [],
        }),
      );
      return dbl;
    },

    fallar(error) {
      cola.push(() => Promise.reject(error));
      return dbl;
    },

    responderConCambios(cambios) {
      cola.push(() =>
        Promise.resolve({ rows: [], rowCount: cambios, command: 'UPDATE', oid: 0, fields: [] }),
      );
      return dbl;
    },
  };

  dbl.cliente = {
    query: (async (sql: string, valores: unknown[] = []) => {
      consultas.push({ sql: String(sql), valores });
      const siguiente = cola.shift();
      if (!preparada(siguiente)) {
        throw new Error(
          `La prueba no准备好 respuesta para:\n${String(sql).trim()}\n` +
            'Agrega un .responder([...]) antes de esta llamada.',
        );
      }
      return siguiente();
    }) as PoolClient['query'],
    release: () => undefined,
    on: () => dbl.cliente as never,
    once: () => dbl.cliente as never,
    removeListener: () => dbl.cliente as never,
  } as unknown as PoolClient;

  return dbl;
}

function preparada<T>(v: T | undefined): v is T {
  return v !== undefined;
}
