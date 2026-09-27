/**
 * Tipos de proveedores.
 *
 * `saldo_actual` es NUMERIC y llega como texto de Postgres, igual que todo
 * el dinero del proyecto: se convierte a number al mapear, nunca antes.
 */
export interface FilaProveedor {
  id: string;
  nombre: string;
  contacto: string | null;
  telefono: string | null;
  saldo_actual: string;
  activo: boolean;
  creado_en: Date;
  compras: string;
}

export interface Proveedor {
  id: number;
  nombre: string;
  contacto: string | null;
  telefono: string | null;
  saldo_actual: number;
  activo: boolean;
  creado_en: string;
}

export interface ProveedorListado {
  id: number;
  nombre: string;
  contacto: string | null;
  telefono: string | null;
  saldo_actual: number;
  activo: boolean;
  compras: number;
}

export interface Listado<T> {
  datos: T[];
  total: number;
  limite: number;
  offset: number;
}

export const mapearProveedor = (f: FilaProveedor): Proveedor => ({
  id: Number(f.id),
  nombre: f.nombre,
  contacto: f.contacto,
  telefono: f.telefono,
  saldo_actual: Number(f.saldo_actual),
  activo: f.activo,
  creado_en: f.creado_en.toISOString(),
});
