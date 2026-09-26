#!/usr/bin/env bash
# Crea una base limpia, aplica la migracion + el seed y corre las dos
# suites de prueba. Todo o nada: si algo falla, sale con codigo != 0.
#
#   ./db/tests/run_tests.sh
#
# Variables de entorno:
#   PGHOST PGPORT PGUSER PGPASSWORD   (psql normal)
#   DB_TEST                            base a crear (por defecto nutr_test)
set -u

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DB_TEST="${DB_TEST:-nutr_test}"
MIG="$RAIZ/db/migrations/0001_init.sql"
SEED="$RAIZ/db/seeds/seed_demo.sql"
BUGS="$RAIZ/db/tests/test_bugs.sql"
AUD="$RAIZ/db/tests/test_auditoria.sql"

fallos=0

echo "== 1/5  base limpia: $DB_TEST =="
psql -d postgres -v ON_ERROR_STOP=1 \
     -c "DROP DATABASE IF EXISTS $DB_TEST;" \
     -c "CREATE DATABASE $DB_TEST;" || { echo "FALLO: no se pudo crear la base"; exit 1; }

echo "== 2/5  migracion 0001_init.sql =="
if psql -d "$DB_TEST" -v ON_ERROR_STOP=1 -f "$MIG" >/tmp/mig.out 2>&1; then
    echo "   OK"
else
    echo "   FALLO"; tail -20 /tmp/mig.out; exit 1
fi

echo "== 3/5  seed_demo.sql =="
if psql -d "$DB_TEST" -v ON_ERROR_STOP=1 -f "$SEED" >/tmp/seed.out 2>&1; then
    echo "   OK"
else
    echo "   FALLO"; tail -20 /tmp/seed.out; exit 1
fi

echo "== 4/5  regresion de los 11 bugs =="
if psql -d "$DB_TEST" -f "$BUGS" 2>&1 | grep -E '^(psql.*)?(NOTICE|ERROR)'; then :; fi
psql -d "$DB_TEST" -q -f "$BUGS" >/dev/null 2>&1 || fallos=$((fallos+1))
[ $fallos -eq 0 ] && echo "   OK" || echo "   FALLO"

echo "== 5/5  usuarios, permisos y auditoria =="
psql -d "$DB_TEST" -f "$AUD" 2>&1 | grep -E '^(psql.*)?(NOTICE|ERROR)'
psql -d "$DB_TEST" -q -f "$AUD" >/dev/null 2>&1 || fallos=$((fallos+1))
[ $fallos -eq 1 ] && echo "   OK" || echo "   FALLO"

echo
echo "== la migracion NO debe poder reaplicarse =="
if psql -d "$DB_TEST" -f "$MIG" 2>&1 | grep -q 'ya fue aplicada'; then
    echo "   OK (bloqueada)"
else
    echo "   FALLO: la migracion se reaplico sin avisar"; fallos=$((fallos+1))
fi

echo
if [ $fallos -eq 0 ]; then
    echo "TODO VERDE"
else
    echo "FALLARON $fallos suite(s)"
fi
exit $fallos
