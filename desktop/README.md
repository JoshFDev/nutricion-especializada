# Nutricion Especializada - Escritorio

Esta versión empaqueta el backend, frontend y PostgreSQL portable con Electron.

## Desarrollo

```bash
# Desde la raíz del repo
pnpm --dir backend build
pnpm --dir frontend build

# Desde desktop/
pnpm install
pnpm dev
```

## Construir instalador (Windows)

```bash
# Asegúrate de que backend y frontend estén compilados
pnpm --dir backend build
pnpm --dir frontend build

# Desde desktop/
pnpm build:dir  # solo directorio
pnpm build      # crea instalador NSIS
```

## Estructura

- `electron/main.ts` - Proceso principal, arranque de PostgreSQL, backend y ventana
- `electron/postgres.ts` - PostgreSQL portable con embedded-postgres
- `electron/migrar-escritorio.ts` - Aplica migraciones sin psql
- `electron/backend.ts` - Lanza el backend Node como proceso hijo
- Los datos se guardan en `%LOCALAPPDATA%\nutricion-especializada-desktop\datos\`

## Notas

- El puerto PostgreSQL es 5433, API en 3131 para evitar conflictos con desarrollo
- Usa el mismo esquema y migraciones de `../../db/migrations`
- El frontend se sirve desde el backend (sin CORS)
- Sincronización con nube: no (independiente)
