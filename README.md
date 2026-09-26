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
  *antes* y *después* de cada movimiento.
- **Vistas** listas para reportes: existencia actual, consumo
  semanal promedio por cliente, estado de cuenta por cliente, y una
  vista por tabla de auditoría con nombres en vez de ids.
- Migraciones versionadas en `db/migrations/`, con datos de prueba
  en `db/seeds/`.

**Pendiente**
- [x] Corregir los 11 bugs de la Avance 1 (ver "Bugs de la Avance 1: estado")
- [ ] API REST en Express (módulo `clientes` ya armado como plantilla)
- [ ] Frontend en Angular
- [ ] Login + endpoint de permisos (usar `fn_tiene_permiso`)
- [ ] Generación de PDF de notas de remisión
- [ ] Deploy (base de datos + backend + frontend)

## Arquitectura elegida

| Capa | Tecnología | Motivo |
|---|---|---|
| Base de datos | PostgreSQL | Soporta triggers, tipos ricos (JSONB), integridad referencial real — necesario para las auditorías del negocio |
| Backend | Express + TypeScript | API REST clásica, control total, fácil de entender y mantener |
| Frontend | Angular | Estructura por módulos, fuertemente tipado, buen ajuste para un sistema con varias pantallas de captura (POS, inventario, cartera) |
| Gestor de paquetes | pnpm | Instalación más rápida y liviana que npm/yarn |

## Estructura del repositorio

```
nutricion-especializada-pos/
├── .gitignore
├── README.md
├── db/
│   ├── migrations/
│   │   └── 0001_init.sql       # esquema completo: tablas, triggers, vistas
│   └── seeds/
│       └── seed_demo.sql       # datos de prueba (no reales)
├── backend/                    # Express + TypeScript (en progreso)
│   └── src/
│       ├── config/db.ts
│       ├── modules/clientes/   # plantilla: service → controller → routes
│       ├── middlewares/
│       └── app.ts / index.ts
└── frontend/                   # Angular (pendiente)
```

> `backend/` y `frontend/` están vacíos por ahora: el README original
> mencionaba `config/db.ts` y `modules/clientes/`, pero nunca se
> escribieron esos archivos. Git tampoco trackea carpetas vacías.

## Cómo levantar lo que ya existe

### 1. Base de datos
Necesitas PostgreSQL 14+ corriendo localmente (o en un contenedor).
```bash
createdb nutricion_especializada
psql -d nutricion_especializada -f db/migrations/0001_init.sql
psql -d nutricion_especializada -f db/seeds/seed_demo.sql   # opcional
```

La migración requiere la extensión `pgcrypto` (para el hash de las
contraseñas). Si da error al crearla, hay que habilitar contrib en el
`postgresql.conf` o crearla como superusuario:
```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;
```


## Usuarios, roles y permisos

### El modelo
```
usuarios ──┬── usuarios_roles ──┬── roles ── roles_permisos ── permisos
           │                     │
           └── (N:M, varios roles por usuario)
```

- **permisos**: la unidad real de acceso, con código `modulo.accion`
  (35 permisos: `clientes.editar`, `caja.eliminar`, `auditoria.caja`...).
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

| Tabla | Qué registra |
|---|---|
| `auditoria_log` | Genérica: cualquier INSERT/UPDATE/DELETE con el JSON anterior y nuevo |
| `auditoria_accesos` | Login exitoso/fallido, logout, acceso denegado, con IP |
| `sesiones` | Sesiones activas (hash del token, IP, inicio, expiración, cierre) |
| `auditoria_caja` | Ingresos y egresos de caja/bancos, con **saldo antes y después** |
| `auditoria_inventario` | Ajustes y mermas, con **existencia antes y después** y el motivo |
| `auditoria_precios` | Cambios de precio de lista, especiales y de costo, con la variación |

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

| # | Bug | Cómo se corrigió |
|---|---|---|
| 1 | Unidades mezcladas en compras | `compra_detalle` ganó `kg_bulto` y su `subtotal` es generado: `cantidad_bultos * kg_bulto * precio_kg`. Un trigger toma `kg_bulto` de `productos.presentacion_kg`. Compra y venta ya usan la misma unidad. |
| 2 | Doble conteo en el saldo del proveedor | `fn_actualizar_saldo_proveedor` ya no excluye las compras pagadas; suma todas las compras no canceladas y resta los pagos. Se recalcula desde cero en cada INSERT/UPDATE/DELETE. |
| 3 | `inventario_semanal.existencia_inicial` en 0 | `fn_recalcular_inventario_semanal` se deriva del kárdex: `inicial` = `final` de la semana anterior, `final` = `inicial + entradas - salidas`. |
| 4 | Triggers de inventario solo en INSERT | `fn_sincronizar_inventario_venta` y `..._compra` ahora reaccionan a UPDATE y DELETE, revierten el movimiento viejo y aplican el nuevo. Cancelar una nota o compra devuelve el stock. |
| 5 | `fn_actualizar_saldo_cuenta` solo en INSERT | Escucha INSERT/UPDATE/DELETE y recalcula el saldo sumando el histórico en vez de acumular. |
| 6 | `folios.folio_numero` UNIQUE global | Ahora es `UNIQUE (serie, folio_numero)`, así conviven varias series. `fn_allegar_folios` y `fn_siguiente_folio` gestionan la serie. |
| 7 | `pagos_aplicacion` sin validación | El trigger `fn_validar_aplicacion_pago` rechaza aplicar más que el monto del pago o más que el saldo de la nota, y avisa si el pago queda negativo o la nota con saldo negativo. |
| 8 | Migración sin atomicidad ni versión | `0001_init.sql` va dentro de `BEGIN/COMMIT` y registra su versión en `schema_migrations`. Reaplicarla falla con un mensaje explícito en vez de duplicar objetos. |
| 9 | Faltan índices en las FK de los triggers de saldo | Se agregaron índices en todas las FK que usa un `SUM()` de los triggers de saldo, inventario y folios. |
| 10 | Permisos no aplicados en la base | `fn_trg_permiso` + `fn_exigir_permiso` bloquean con SQLSTATE `42501` cualquier operación sin permiso. Los movimientos de inventario generados por el sistema (venta/compra) quedan exentos, y los ajustes manuales siguen requiriendo `inventario.ajustar`. |
| 11 | `precio_bulto` capturado a mano | El trigger `fn_calcular_precio_bulto` lo calcula como `precio_kg * productos.presentacion_kg`. |

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
Aún no generado

### 3. Frontend
Aún no generado

## Convenciones del proyecto
- Las migraciones nunca se editan una vez aplicadas: se agrega
  `0002_algo.sql`, `0003_algo.sql`, etc.
- Cada entidad de negocio (clientes, productos, notas de remisión...)
  vive en su propio módulo/feature, tanto en backend como en frontend.
- Los datos reales de clientes **nunca** se suben al repositorio
  (ver `.gitignore`); solo se usan datos de `seed_demo.sql` para
  pruebas.
