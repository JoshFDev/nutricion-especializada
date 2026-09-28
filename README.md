# Nutrición Especializada — Sistema POS / Inventario / Cartera

Sistema para automatizar los procesos que hoy se llevan en Excel:
punto de venta (notas de remisión), inventario semanal, cartera de
clientes y proveedores, y flujo de caja/bancos.

## Estado actual del proyecto — Avance 1

**Modelo de datos (PostgreSQL)** — completo

- Esquema normalizado: clientes, productos, precios por cliente,
  proveedores, compras, folios, notas de remisión, pagos/abonos,
  facturación, inventario (kárdex + foto semanal), caja/bancos.
- **Usuarios, roles y permisos**: modelo RBAC. Los permisos son la unidad
  real de acceso (`caja.eliminar`), se agrupan en roles, y un usuario
  puede tener **varios** roles. Contraseñas con hash bcrypt.
- **Triggers de auditoría y automatización**: control de folios,
  descuento automático de inventario al vender, alta automática al
  comprar, alerta de stock negativo, recálculo automático de saldos
  de clientes/proveedores/cuentas, bitácora de cambios
  (`auditoria_log`).
- **Auditoría por módulo**: además de la bitácora genérica hay tablas
  listas para pantalla, una por área sensible — accesos y sesiones,
  caja y bancos, ajustes de inventario, y cambios de precios.
  Cada una se llena sola por trigger y guarda el saldo/existencia
  _antes_ y _después_ de cada movimiento.
- **Vistas** listas para reportes: existencia actual, consumo
  semanal promedio por cliente, estado de cuenta por cliente, y una
  vista por tabla de auditoría con nombres en vez de ids.
- Migraciones versionadas en `db/migrations/`, con datos de prueba
  en `db/seeds/`.

**Pendiente**

- [x] Corregir los 11 bugs de la Avance 1 (ver "Bugs de la Avance 1: estado")
- [x] API REST en Express (15 módulos: `salud`, `auth`, `catalogo`,
      `clientes`, `usuarios`, `productos`, `precios`, `notas-remision`,
      `pagos`, `proveedores`, `compras`, `inventario`, `caja`,
      `facturacion` y `auditoria`)
- [x] Login + endpoint de permisos (usar `fn_tiene_permiso`)
- [x] Generación de PDF de notas de remisión
- [ ] Frontend en Angular
- [ ] Deploy (base de datos + backend + frontend)

> **La API no tiene rate limit**, ni general ni en el login: mientras la
> aplicación sea local y no quede expuesta a internet no hace falta, y solo
> estorbaba a la suite de integración. Si se publica, hay que volver a
> ponerlo **delante** de la app, no confiando en que nadie más la llama.

## Arquitectura elegida

| Capa               | Tecnología           | Motivo                                                                                                                             |
| ------------------ | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Base de datos      | PostgreSQL           | Soporta triggers, tipos ricos (JSONB), integridad referencial real — necesario para las auditorías del negocio                     |
| Backend            | Express + TypeScript | API REST clásica, control total, fácil de entender y mantener                                                                      |
| Frontend           | Angular              | Estructura por módulos, fuertemente tipado, buen ajuste para un sistema con varias pantallas de captura (POS, inventario, cartera) |
| Gestor de paquetes | pnpm                 | Instalación más rápida y liviana que npm/yarn                                                                                      |

## Estructura del repositorio

```
nutricion-especializada-pos/
├── .gitignore
├── README.md
├── db/
│   ├── migrations/
│   │   ├── 0001_init.sql                  # esquema completo: tablas, triggers, vistas
│   │   ├── 0002_motivos_cierre_sesion.sql
│   │   ├── 0003_permisos_catalogo.sql
│   │   ├── 0004_colacion_espanol.sql
│   │   ├── 0005_productos_codigo_ci.sql
│   │   ├── 0006_permisos_cajera.sql
│   │   ├── 0007_precios_sin_traslape.sql
│   │   ├── 0008_notas_bloqueo_estado.sql
│   │   ├── 0009_compras_motivo_cancelacion.sql
│   │   └── 0010_facturas_auditoria_permisos.sql
│   ├── seeds/
│   │   └── seed_demo.sql                  # datos de prueba (no reales)
│   └── tests/                             # pruebas en SQL puro
├── backend/                               # Express + TypeScript
│   ├── src/
│   │   ├── core/                          # errores tipados, validación con Zod
│   │   ├── db/                            # pool y cliente por request
│   │   ├── middleware/                    # sesión, permisos, manejador de errores
│   │   ├── modules/                       # salud, auth, catalogo, clientes,
│   │   │                                  #   usuarios, productos, precios,
│   │   │                                  #   notas-remision, pagos,
│   │   │                                  #   proveedores, compras,
│   │   │                                  #   inventario, caja,
│   │   │                                  #   facturacion, auditoria
│   │   ├── config/                        # entorno validado con Zod
│   │   ├── app.ts                         # composición: orden de middlewares
│   │   └── index.ts                       # arranque y cierre del pool
│   └── tests/
│       ├── api.test.mjs                   # 834 pruebas contra la API real
│       └── unit/                          # pruebas de esquemas y servicios
└── frontend/                              # Angular (vacío por ahora)
```

> `frontend/` sigue vacío: la API está completa pero no hay nada que
> clicar todavía.

## Cómo levantar lo que ya existe

### 1. Base de datos

Necesitas PostgreSQL 14+ corriendo localmente (o en un contenedor). La
migración requiere la extensión `pgcrypto` (para el hash de las
contraseñas); si da error al crearla, hay que habilitar contrib en el
`postgresql.conf` o crearla como superusuario:

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;
```

Con eso, desde `backend/`:

```bash
pnpm install
pnpm migrar        # aplica 0001..0010 en orden, cada una en su transacción
pnpm migrar:seed   # datos de demostración (opcional)
```

El migrador registra lo aplicado en `pos.schema_migrations`, así que correrlo
de nuevo no repite nada. `PGDATABASE` decide sobre qué base se aplica: sin
esa variable usa la de `.env`.

## Cómo correr las pruebas

```bash
cd backend
pnpm verificar      # formato, lint, tipos y pruebas unitarias
```

Las pruebas de integración necesitan la API corriendo **contra una base de
pruebas**, nunca contra la real: la suite cambia contraseñas y borra
registros, y por eso lee `/api/salud` antes de tocar nada y se sale si la
base no parece de pruebas.

```bash
# en una terminal
PGDATABASE=nutr_test pnpm dev
# en otra
pnpm test:api       # 834 pruebas contra la API de verdad
```

`nutr_test` se arma sola: el migrador la crea si no existe.

```bash
PGDATABASE=nutr_test pnpm migrar
PGDATABASE=nutr_test pnpm migrar:seed
```

La suite es reejecutable: limpia al empezar y al terminar, y usa una marca de
agua por corrida en las tablas de auditoría para borrar solo lo que ella
misma escribió, sin tocar los rastros del seed. Por eso se puede correr las
veces que haga falta sin dejar basura detrás.

## Caja, facturación y auditoría

Los tres módulos del último lote, y lo que cada uno decide.

### `caja` — cuentas, movimientos y saldos (`/api/caja`)

| Endpoint                  | Qué hace                                       |
| ------------------------- | ---------------------------------------------- |
| `GET/POST /cuentas`       | Lista y abre cuentas de efectivo o banco       |
| `GET /cuentas/:id`        | Una cuenta con su saldo                        |
| `GET/POST /movimientos`   | Lista y captura ingresos y egresos             |
| `GET /movimientos/:id`    | Un movimiento                                  |
| `DELETE /movimientos/:id` | **El único DELETE de todo el proyecto**        |
| `GET /resumen`            | Ingresos, egresos y saldo por cuenta y periodo |
| `GET /categorias`         | Categorías usadas, para los desplegables       |

- El saldo **no se manda nunca**: lo calcula el trigger
  `trg_actualizar_saldo_cuenta` sumando el histórico de la cuenta.
- El saldo **negativo se permite**. Una transferencia se registra el día que
  se emite y la cuenta queda corrida hasta la compensación; bloquearlo
  empujaría al operador a registrar el movimiento en otra cuenta.
- **No hay PATCH**: un movimiento se corrige borrándolo y capturándolo de
  nuevo, que es lo único que deja rastro real de las dos cosas.
- El alta y el borrado se serializan con `SELECT ... FOR UPDATE` sobre la
  cuenta, tomado **antes** de validar y hasta el `COMMIT`. Sin ese candado dos
  altas simultáneas de la misma cuenta se pisan el saldo.
- El `DELETE` es el único borrado del sistema y por eso tiene su propio
  permiso (`caja.eliminar`, que la Cajera tiene y la Empleada no): en los
  demás módulos el registro tiene nombre y aparece en documentos viejos; un
  movimiento de caja solo existe en `auditoria_caja`.

### `facturacion` — factura al cliente (`/api/facturas`)

| Endpoint             | Qué hace                            |
| -------------------- | ----------------------------------- |
| `GET /` `GET /:id`   | Lista y consulta facturas           |
| `POST /`             | Factura una o más notas de remisión |
| `PATCH /:id/estatus` | `solicitada → emitida → cancelada`  |

- El `monto_total` es **derivado**: la suma de los subtotales de las notas, y
  no se acepta en el POST. Aceptarlo abriría la puerta a facturar una nota
  por una cantidad que no es la que se vendió.
- Las tres reglas que la base **no** prohibe y el servicio sí:
  1. una nota de **otro** cliente (`factura_nota` no liga ambos ids);
  2. una nota **cancelada** (mercancía que no salió);
  3. una nota ya en **otra factura viva** (la misma venta cobrada dos veces).
- Los estatus van en un solo sentido. Cancelar **exige motivo**, y no por
  buena voluntad: es un `CHECK` de la base, el mismo patrón que notas
  (0008) y compras (0009).
- Cancelar **no devuelve** las notas a un talonario ni cambia su estatus: el
  folio ya salió de la casa y la mercancia sí se entregó. Lo que hace falta es
  una factura **nueva** con las mismas notas, y eso ya se puede, porque una
  factura cancelada deja de contar como activa.
- Una misma nota repetida en el mismo `POST` se ignora (es casi siempre un
  doble clic); sin ese `Set` el `monto_total` la contaría dos veces.

### `auditoria` — solo lectura (`/api/auditoria`)

Cinco bitácoras, cinco `GET`, y **ninguna** forma de escribir: `POST`, `PUT`,
`PATCH` y `DELETE` dan 404, que es la única respuesta aceptable para una
bitácora.

```
GET /log          cualquier INSERT/UPDATE/DELETE, con el JSON antes y después
GET /accesos      login exitoso/fallido, logout, con IP
GET /caja         ingresos y egresos, con el saldo antes y después
GET /inventario   ajustes y mermas, con la existencia antes y después
GET /precios      cambios de precio, con la variación
```

- Se consultan las **tablas base**, no las vistas `vw_auditoria_*` de 0001:
  las vistas no traen los ids, y sin ids no se puede filtrar por cuenta,
  producto, cliente o usuario, que es como se usa esto ("muéstrame los
  movimientos de la cuenta 3"). Cada renglón trae las dos cosas: el nombre
  para la pantalla y el id para el filtro.
- Los rangos de fecha son **inclusivos**: las columnas `DATE` se filtran con
  `<= $::date` y las `TIMESTAMP` con `< $::date + 1`. Con `<= $::date` sobre
  un timestamp, "hoy" no traía nada.
- La Cajera ve las cuatro bitácoras de cambios pero no `accesos`; la Empleada
  no ve ninguna. Son las separaciones que ya traían `0006`, ahora con rutas
  donde se pueden probar.

## Usuarios, roles y permisos

### El modelo

```
usuarios ──┬── usuarios_roles ──┬── roles ── roles_permisos ── permisos
           │                     │
           └── (N:M, varios roles por usuario)
```

- **permisos**: la unidad real de acceso, con código `modulo.accion`
  (44 permisos: `clientes.editar`, `caja.eliminar`, `auditoria.caja`...).
  Los de notas de remisión son `notas.ver`, `notas.crear`, `notas.editar`,
  `notas.cancelar` y `notas.folios`; este último lo administra solo el
  Administrador (migración 0008), porque es quien declara una serie completa.
- **roles**: agrupa permisos. Vienen tres: `Administrador` (todo),
  `Empleada` (opera el día a día, sin precios ni caja.eliminar) y
  `Cajera` (caja y cobranza, sin ver precios).
- **usuarios**: nombre, apellido paterno/materno, RFC, fecha de
  contratación, puesto, email, y la contraseña **hasheada con bcrypt**.

### Contraseñas

Nunca se guardan en texto plano. Para asignar una:

```sql
UPDATE usuarios
   SET contrasena = crypt('la-clave-nueva', gen_salt('bf', 12)),
       debe_cambiar_contrasena = TRUE
 WHERE rfc = 'NENR800101HDF';
```

Para validar un intento de login:

```sql
SELECT crypt('lo-que-escribio', contrasena) = contrasena AS ok
  FROM usuarios
 WHERE activo AND (email = 'correo' OR rfc = 'ABC010101HDF');
```

`sesiones.token_hash` guarda el **hash sha256** del token, nunca el token.

### Cómo la base de datos sabe quién está operando

`current_user` devuelve el rol de Postgres, que es el mismo para todos,
así que no sirve para saber qué persona hizo un cambio. Por eso el
backend anuncia el usuario al abrir cada transacción:

```sql
BEGIN;
SELECT fn_iniciar_sesion(1, '192.168.1.20');   -- id del usuario + IP
UPDATE clientes SET nombre = '...' WHERE id = 5;
COMMIT;
```

`fn_iniciar_sesion` usa `set_config(..., TRUE)`, o sea **LOCAL**: el
valor se borra al cerrar la transacción y no se filtra a la petición
siguiente. A partir de ahí, `fn_usuario_actual()` lo devuelven todos los
triggers de auditoría. Si no se llama, los triggers graban
`usuario_id = NULL` (se ve como `(sistema)` en las vistas).

> **Limitación conocida:** un usuario con acceso a la base de datos
> podría hacer `SET app.usuario_id` y suplantar a otro. Para cerrarlo
> del todo hace falta que cada persona entre con su propio rol de
> Postgres, o mover la auditoría al backend. Con la contraseña de
> `postgres` compartida esto es aceptable para el alcance actual.

### Funciones de permisos para el backend

```sql
SELECT fn_tiene_permiso('caja.eliminar');   -- ¿puede hacer esto?
SELECT fn_es_admin();                        -- ¿es admin o la dueña?
SELECT fn_tiene_rol('Cajera');
SELECT * FROM fn_permisos_usuario_actual();  -- todos, para el frontend
```

## Auditoría

| Tabla                  | Qué registra                                                          |
| ---------------------- | --------------------------------------------------------------------- |
| `auditoria_log`        | Genérica: cualquier INSERT/UPDATE/DELETE con el JSON anterior y nuevo |
| `auditoria_accesos`    | Login exitoso/fallido, logout, acceso denegado, con IP                |
| `sesiones`             | Sesiones activas (hash del token, IP, inicio, expiración, cierre)     |
| `auditoria_caja`       | Ingresos y egresos de caja/bancos, con **saldo antes y después**      |
| `auditoria_inventario` | Ajustes y mermas, con **existencia antes y después** y el motivo      |
| `auditoria_precios`    | Cambios de precio de lista, especiales y de costo, con la variación   |

Todas se llenan solas por trigger, no hay que hacer nada desde la
aplicación. Cada una tiene una vista con nombres en lugar de ids:
`vw_auditoria_log`, `vw_auditoria_accesos`, `vw_auditoria_caja`,
`vw_auditoria_inventario`, `vw_auditoria_precios`, y
`vw_usuarios_permisos`.

Dos detalles de seguridad ya resueltos en el esquema:

- `fn_redactar()` reemplaza `contrasena`, `token` y `token_hash` por
  `"[REDACTADO]"` antes de guardarlos en la bitácora, para que el hash
  de la contraseña no quede paseando en `auditoria_log`.
- Los ajustes y mermas de inventario exigen `motivo` (CHECK
  `chk_motivo_requerido`): no se puede mover stock sin justificar.

**Ojo:** los `AFTER` triggers de PostgreSQL se disparan en **orden
alfabético por nombre**. `fn_auditar_caja` por eso NO lee
`cuentas_financieras.saldo_actual` (que el trigger de saldo ya pudo
haber modificado): recalcula el saldo real del movimiento, que da igual
sin importar el orden.

## Bugs de la Avance 1: estado

Los 11 problemas detectados al revisar el modelo están **corregidos** en
`db/migrations/0001_init.sql` y cubiertos por una prueba de regresión
por cada uno (`db/tests/test_bugs.sql`). La migración aún no se había
aplicado a la base real, así que se corrigió el archivo en lugar de
encadenar parches.

| #   | Bug                                               | Cómo se corrigió                                                                                                                                                                                                                                            |
| --- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Unidades mezcladas en compras                     | `compra_detalle` ganó `kg_bulto` y su `subtotal` es generado: `cantidad_bultos * kg_bulto * precio_kg`. Un trigger toma `kg_bulto` de `productos.presentacion_kg`. Compra y venta ya usan la misma unidad.                                                  |
| 2   | Doble conteo en el saldo del proveedor            | `fn_actualizar_saldo_proveedor` ya no excluye las compras pagadas; suma todas las compras no canceladas y resta los pagos. Se recalcula desde cero en cada INSERT/UPDATE/DELETE.                                                                            |
| 3   | `inventario_semanal.existencia_inicial` en 0      | `fn_recalcular_inventario_semanal` se deriva del kárdex: `inicial` = `final` de la semana anterior, `final` = `inicial + entradas - salidas`.                                                                                                               |
| 4   | Triggers de inventario solo en INSERT             | `fn_sincronizar_inventario_venta` y `..._compra` ahora reaccionan a UPDATE y DELETE, revierten el movimiento viejo y aplican el nuevo. Cancelar una nota o compra devuelve el stock.                                                                        |
| 5   | `fn_actualizar_saldo_cuenta` solo en INSERT       | Escucha INSERT/UPDATE/DELETE y recalcula el saldo sumando el histórico en vez de acumular.                                                                                                                                                                  |
| 6   | `folios.folio_numero` UNIQUE global               | Ahora es `UNIQUE (serie, folio_numero)`, así conviven varias series. `fn_allegar_folios` y `fn_siguiente_folio` gestionan la serie.                                                                                                                         |
| 7   | `pagos_aplicacion` sin validación                 | El trigger `fn_validar_aplicacion_pago` rechaza aplicar más que el monto del pago o más que el saldo de la nota, y avisa si el pago queda negativo o la nota con saldo negativo.                                                                            |
| 8   | Migración sin atomicidad ni versión               | `0001_init.sql` va dentro de `BEGIN/COMMIT` y registra su versión en `schema_migrations`. Reaplicarla falla con un mensaje explícito en vez de duplicar objetos.                                                                                            |
| 9   | Faltan índices en las FK de los triggers de saldo | Se agregaron índices en todas las FK que usa un `SUM()` de los triggers de saldo, inventario y folios.                                                                                                                                                      |
| 10  | Permisos no aplicados en la base                  | `fn_trg_permiso` + `fn_exigir_permiso` bloquean con SQLSTATE `42501` cualquier operación sin permiso. Los movimientos de inventario generados por el sistema (venta/compra) quedan exentos, y los ajustes manuales siguen requiriendo `inventario.ajustar`. |
| 11  | `precio_bulto` capturado a mano                   | El trigger `fn_calcular_precio_bulto` lo calcula como `precio_kg * productos.presentacion_kg`.                                                                                                                                                              |

### Un detalle importante sobre los triggers BEFORE

Un trigger `BEFORE` que hace `RETURN NULL` **cancela la operación en
silencio**: el `INSERT` simplemente no ocurre y no sale ningún error.
Por eso `fn_trg_permiso` devuelve `NEW` (o `OLD` en `DELETE`) y no
`NULL`. Es fácil de escribir mal y muy difícil de detectar, porque la
base "acepta" todo mientras no guarda nada.

### Ejecutar las pruebas

```bash
db/tests/test_bugs.sql        # los 11 bugs
db/tests/test_auditoria.sql   # usuarios, permisos, bcrypt y auditoría
```

Ambas arrancan con `ON_ERROR_STOP`: si algún `RAISE EXCEPTION` salta, el
script se detiene. Cada una necesita una base recién creada con la
migración y el seed aplicados (ver "Arranque" más arriba).

### 2. Backend

```bash
cd backend
pnpm install
pnpm dev           # tsx watch, en http://localhost:3000
pnpm build         # tsc a dist/
```

La composición de la app vive en `src/app.ts`, no en `index.ts`: así se
puede probar la app sin abrir un puerto. El orden de los middlewares está
documentado ahí mismo, y el último de todos es el manejador de errores
(Express solo reconoce uno de esos por tener 4 argumentos).

### El PDF de la nota de remisión

```
GET /api/notas-remision/:id/pdf   →   application/pdf
```

Sale con el mismo permiso que `GET /:id` (`notas.ver`): imprimir no es una
operación distinta de ver, y un permiso aparte solo serviría para que
alguien se quede sin poder imprimir su propia nota.

| Variable            | Para qué                                              |
| ------------------- | ----------------------------------------------------- |
| `EMPRESA_NOMBRE`    | Título del membrete. Es la única obligatoria         |
| `EMPRESA_RFC`       | Sale bajo el nombre; vacío = no se imprime            |
| `EMPRESA_DIRECCION` | Ídem                                                 |
| `EMPRESA_TELEFONO`  | Ídem                                                 |

El membrete va en el entorno y no en una tabla porque no es dato del
negocio: es el membrete, y cambia cuando cambias de domicilio, no cuando
llega una venta. Meterlo en el código obliga a tocar y redesplegar la app
para corregir un teléfono mal escrito; meterlo en la base obliga a migrar
datos que no cambian.

Tres cosas del render que no son obvias y que están comentadas en
`src/modules/notas-remision/pdf.ts`:

- **Se arma entero en memoria, no con `doc.pipe(res)`.** `pipe` manda las
  cabeceras antes de saber si el documento se pudo dibujar, y a partir de
  ahí un error ya no se puede convertir en un 404: el manejador de errores
  intentaría poner un JSON encima de una respuesta que ya empezó a salir
  como PDF. Armando el buffer primero, un fallo es un fallo de verdad y el
  cliente recibe el mismo JSON que en cualquier otra ruta. Una nota son
  decenas de renglones: el buffer pesa unos cuantos kilobytes.
- **Los saltos de página son a mano.** `doc.text` con coordenadas
  absolutas no pagina solo (eso solo pasa con el flujo normal), así que
  cada bloque pregunta si cabe, y al saltar se redibujan los títulos de
  la tabla. El pie va con `margins.bottom = 0`, porque si no pdfkit le
  agrega una página por debajo a cada hoja real.
- **El texto se normaliza a NFC antes de imprimirse.** Un nombre tecleado
  en macOS llega descompuesto (la vocal y el acento por separado) y
  sin eso el acento se pierde en el papel. Lo que no existe en WinAnsi
  se cambia por `?` a propósito: un `?` en el papel se ve y se pregunta.

El importe que sale es el `subtotal` de la nota, **no** la suma de los
renglones: es el que mantiene `fn_recalcular_subtotal_nota` y el que usa
la base para el saldo del cliente. Bultos y kilos sí se suman, porque no
hay ninguna columna que los traiga.

`tests/unit/notas.pdf.test.ts` comprueba el render sin base de datos: que
salga un PDF válido, que el folio, el cliente y los importes estén en el
papel, que una nota larga salte de página repitiendo los títulos, y que
una nota cancelada avise con su motivo. Para leer el texto de un PDF hay
que descomprimir sus flujos: el helper del test va por el `/Length` de
cada objeto porque los datos comprimidos pueden contener literalmente los
bytes `stream` y `endstream` dentro.

### 3. Frontend

Aún no generado. `frontend/` está vacío a propósito: la API está completa y
probada, pero no hay nada que clicar todavía.

## Convenciones del proyecto

- Las migraciones nunca se editan una vez aplicadas: se agrega
  `0002_algo.sql`, `0003_algo.sql`, etc.
- Cada entidad de negocio (clientes, productos, notas de remisión...)
  vive en su propio módulo/feature, tanto en backend como en frontend.
- Los datos reales de clientes **nunca** se suben al repositorio
  (ver `.gitignore`); solo se usan datos de `seed_demo.sql` para
  pruebas.
