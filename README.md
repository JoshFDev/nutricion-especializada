# Nutrición Especializada — Sistema POS / Inventario / Cartera

Sistema para automatizar los procesos que hoy se llevan en Excel:
punto de venta (notas de remisión), inventario semanal, cartera de
clientes y proveedores, y flujo de caja/bancos.

## Estado actual del proyecto — Avance 1

**Modelo de datos (PostgreSQL)** — completo
- Esquema normalizado: clientes, productos, precios por cliente,
  proveedores, compras, folios, notas de remisión, pagos/abonos,
  facturación, inventario (kárdex + foto semanal), caja/bancos.
- **Triggers de auditoría y automatización**: control de folios,
  descuento automático de inventario al vender, alta automática al
  comprar, alerta de stock negativo, recálculo automático de saldos
  de clientes/proveedores/cuentas, bitácora de cambios
  (`auditoria_log`).
- **Vistas** listas para reportes: existencia actual, consumo
  semanal promedio por cliente, estado de cuenta por cliente.
- Migraciones versionadas en `db/migrations/`, con datos de prueba
  en `db/seeds/`.

**Pendiente**
- [ ] API REST en Express (módulo `clientes` ya armado como plantilla)
- [ ] Frontend en Angular
- [ ] Autenticación / roles (dueña, empleados)
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

## Cómo levantar lo que ya existe

### 1. Base de datos
Necesitas PostgreSQL 14+ corriendo localmente (o en un contenedor).
```bash
createdb nutricion_especializada
psql -d nutricion_especializada -f db/migrations/0001_init.sql
psql -d nutricion_especializada -f db/seeds/seed_demo.sql   # opcional
```

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
