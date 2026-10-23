/**
 * Prepara una copia de produccion del backend para empaquetarla.
 *
 * Copiar `backend/node_modules` tal cual arrastraria todo el arbol de
 * desarrollo (TypeScript, ESLint, Vitest...) al instalador. Este script
 * arma `desktop/backend-produccion` solo con lo que el backend necesita en
 * tiempo de ejecucion:
 *
 *   - dist/        codigo compilado
 *   - plantillas/  logo y hojas de Excel que se leen en tiempo de ejecucion
 *   - package.json y pnpm-lock.yaml
 *   - node_modules con SOLO dependencias de produccion
 *
 * El resultado lo consume `electron-builder.yml` via `extraResources`.
 */
import { execSync } from 'node:child_process';
import { copyFile, cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const aqui = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(aqui, '..');
const raiz = resolve(desktop, '..');
const backend = join(raiz, 'backend');
const destino = join(desktop, 'backend-produccion');

console.log(`[recursos] Preparando backend en ${destino}`);

await rm(destino, { recursive: true, force: true });
await mkdir(destino, { recursive: true });

for (const carpeta of ['dist', 'plantillas']) {
  await cp(join(backend, carpeta), join(destino, carpeta), { recursive: true });
}

for (const archivo of ['package.json', 'pnpm-lock.yaml']) {
  await copyFile(join(backend, archivo), join(destino, archivo));
}

console.log('[recursos] Instalando dependencias de produccion...');
try {
  execSync('pnpm install --prod --no-frozen-lockfile --ignore-scripts', {
    cwd: destino,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
} catch (error) {
  console.error('[recursos] Fallo instalando dependencias de produccion');
  throw error;
}

console.log('[recursos] Backend de produccion listo');
