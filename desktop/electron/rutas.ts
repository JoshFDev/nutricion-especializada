import { app } from 'electron';
import { join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';

export function obtenerRutas() {
  const userData = app.getPath('userData');
  const datos = join(userData, 'datos');
  const pgData = join(datos, 'pgdata');
  const backups = join(datos, 'backups');
  const logs = join(datos, 'logs');

  for (const dir of [datos, pgData, backups, logs]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  return {
    userData,
    datos,
    pgData,
    backups,
    logs,
    baseDatos: 'nutricion_especializada_escritorio',
    usuario: 'pos_app',
    password: 'pos_app_local',
    puertoPg: 5433,
    puertoApi: 3131,
  };
}
