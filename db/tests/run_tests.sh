#!/usr/bin/env bash
# Crea una base DE DESCARTE, aplica TODAS las migraciones + el seed y corre
# las dos suites de prueba en SQL. Todo o nada: si algo falla, sale con
# codigo != 0.
#
#   ./db/tests/run_tests.sh
#
# Variables de entorno:
#   PGHOST PGPORT PGUSER PGPASSWORD   (psql normal)
#   PSQL                                binario de psql (por defecto, psql)
#   DB_TEST                             base a crear (por defecto nutr_test_sql)
#
# -----------------------------------------------------------------------------
# POR QUE LA BASE ES "DE DESCARTE" Y NO `nutr_test`
#
# Este script BORRA la base que crea y vuelve a armarla. Antes el valor por
# omision era `nutr_test`, que es la MISMA base de desarrollo (la de
# backend/.env). Con eso, un `DROP DATABASE` se comia las 22 migraciones y
# todos los datos del que estaba trabajando, sin avisar.
#
# Ahora:
#
#   1. La base por omision se llama `nutr_test_sql`, que es de usar y tirar.
#   2. El script se NIEGA a correr si la base que le piden es la de
#      desarrollo (la de backend/.env o la de $PGDATABASE). No es un aviso:
#      es un `exit 1` con el motivo.
#   3. Ademas, el nombre tiene que decir "test" (o "tmp"), por si alguien
#      se equivoca al escribir la variable.
#
# -----------------------------------------------------------------------------
# POR QUE SE APLICAN TODAS LAS MIGRACIONES
#
# Antes solo se aplicaba `0001_init.sql`, o sea que las pruebas en SQL
# corrían contra un esquema 21 migraciones atrasado: distinto del que usa
# la aplicacion. Ahora se usa el migrador del proyecto, que aplica todo lo
# que falte en orden y deja el registro en `schema_migrations`.
set -u

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DB_TEST="${DB_TEST:-nutr_test_sql}"
PSQL="${PSQL:-psql}"
BUGS="$RAIZ/db/tests/test_bugs.sql"
AUD="$RAIZ/db/tests/test_auditoria.sql"

fallos=0

# La conexion: si no esta en el entorno, se toma de backend/.env. `psql` no
# lee el .env solo, asi que sin esto habia que exportarlo a mano.
if [ -f "$RAIZ/backend/.env" ] && [ -z "${PGHOST:-}" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$RAIZ/backend/.env"
  set +a
fi

# ---------------------------------------------------------------- seguridad
#
# La base de desarrollo sale de backend/.env (o de $PGDATABASE). Si la que
# nos piden ES esa, se para aqui: este script borra lo que encuentre.
DEV_DB=""
if [ -f "$RAIZ/backend/.env" ]; then
  DEV_DB="$(sed -n 's/^PGDATABASE=//p' "$RAIZ/backend/.env" | head -1 | tr -d '\r"')"
fi
[ -z "$DEV_DB" ] && DEV_DB="${PGDATABASE:-}"

if [ "$DB_TEST" = "$DEV_DB" ]; then
  echo "FALLO: '$DB_TEST' es la base de DESARROLLO (backend/.env)."
  echo "       Este script borra la base que usa. Usa otra:"
  echo "         DB_TEST=nutr_test_sql ./db/tests/run_tests.sh"
  exit 1
fi

case "$DB_TEST" in
  *test* | *tmp*) ;;
  *)
    echo "FALLO: el nombre de la base tiene que decir 'test' o 'tmp'."
    echo "       (se pide '$DB_TEST')"
    exit 1
    ;;
esac

echo "== 0/6  base de descarte: $DB_TEST (desarrollo: ${DEV_DB:-desconocida}) =="

# ------------------------------------------------------------- base limpia
echo "== 1/6  se crea desde cero =="
if ! "$PSQL" -d postgres -v ON_ERROR_STOP=1 \
     -c "DROP DATABASE IF EXISTS $DB_TEST;" \
     -c "CREATE DATABASE $DB_TEST;" >/tmp/db_test_base.out 2>&1; then
  echo "FALLO: no se pudo crear la base"; tail -20 /tmp/db_test_base.out; exit 1
fi
echo "   OK"

# ------------------------------------------- migraciones + seed (el migrador)
#
# Se usa el migrador del proyecto, no `psql -f 0001_init.sql`: asi se
# aplican TODAS las migraciones, en orden, y la base queda igual que la de
# la aplicacion (mismo esquema, mismo registro).
echo "== 2/6  migraciones (todas) + seed =="
cd "$RAIZ/backend" || exit 1
if [ -x node_modules/.bin/tsx ]; then
  CORRER_MIGRADOR=(node_modules/.bin/tsx scripts/migrar.ts --seed)
else
  CORRER_MIGRADOR=(npx tsx scripts/migrar.ts --seed)
fi
if PGDATABASE="$DB_TEST" "${CORRER_MIGRADOR[@]}" >/tmp/db_test_mig.out 2>&1; then
  echo "   OK"
else
  echo "FALLO: el migrador no pudo aplicar todo"; tail -30 /tmp/db_test_mig.out; exit 1
fi

# ------------------------------------------------- la migracion NO se re-aplica
echo "== 3/6  las migraciones NO se pueden reaplicar =="
if PGDATABASE="$DB_TEST" "${CORRER_MIGRADOR[@]}" 2>&1 | grep -q 'No hay migraciones pendientes'; then
  echo "   OK (bloqueada: el migrador no las vuelve a aplicar)"
else
  echo "FALLO: las migraciones se reaplicaron"; fallos=$((fallos+1))
fi

# ----------------------------------------------------------------- las suites
echo "== 4/6  regresion de los bugs (SQL) =="
fallos_antes=$fallos
if "$PSQL" -d "$DB_TEST" -f "$BUGS" 2>&1 | grep -E '^(psql.*)?(NOTICE|ERROR)'; then :; fi
"$PSQL" -d "$DB_TEST" -q -f "$BUGS" >/dev/null 2>&1 || fallos=$((fallos+1))
[ $fallos -eq $fallos_antes ] && echo "   OK" || echo "   FALLO"

echo "== 5/6  usuarios, permisos y auditoria (SQL) =="
fallos_antes=$fallos
if "$PSQL" -d "$DB_TEST" -f "$AUD" 2>&1 | grep -E '^(psql.*)?(NOTICE|ERROR)'; then :; fi
"$PSQL" -d "$DB_TEST" -q -f "$AUD" >/dev/null 2>&1 || fallos=$((fallos+1))
[ $fallos -eq $fallos_antes ] && echo "   OK" || echo "   FALLO"

# ----------------------------------------------------------------- limpieza
echo "== 6/6  la base de descarte se deja como estaba =="
# Se deja en pie: repetir la suite es mas rapido que recrearla, y el
# contenido no se usa para nada mas. Para borrarla:
#   dropdb $DB_TEST
echo "   (queda en pie; borrala con: dropdb $DB_TEST)"

echo
if [ $fallos -eq 0 ]; then
  echo "TODO VERDE"
else
  echo "FALLARON $fallos suite(s)"
fi
exit $fallos
