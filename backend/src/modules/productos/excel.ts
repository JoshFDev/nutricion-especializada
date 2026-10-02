import ExcelJS from 'exceljs';
import { kilosComoTexto } from '../../core/valores.js';
import type { Producto } from './modelo.js';

/**
 * El Excel de la LISTA de productos.
 *
 * Genera una hoja limpia con las columnas que se ven en la tabla:
 * Codigo, Nombre, Presentacion (kg), Categoria, Especie, Estado.
 */
export async function excelListaProductos(
  productos: Producto[],
): Promise<Buffer> {
  const libro = new ExcelJS.Workbook();
  const hoja = libro.addWorksheet('Productos');

  libro.title = 'Listado de productos';
  libro.creator = 'Nutricion Especializada';

  // Cabeceras - anchos base, se ajustan auto al contenido después
  hoja.columns = [
    { header: 'Codigo', key: 'codigo', width: 18 },
    { header: 'Nombre', key: 'nombre', width: 45 },
    { header: 'Presentacion (kg)', key: 'presentacion_kg', width: 20 },
    { header: 'Categoria', key: 'categoria', width: 25 },
    { header: 'Especie', key: 'especie', width: 25 },
    { header: 'Estado', key: 'activo', width: 14 },
  ];

  // Alineación: TODOS los datos centrados
  for (const col of hoja.columns) {
    if (col.key) {
      hoja.getColumn(col.key).alignment = { horizontal: 'center', vertical: 'middle' };
    }
  }

  // Estilo de cabecera - solo columnas A-F (1-6), centrados
  const cabeceraEstilo: Partial<ExcelJS.Style> = {
    font: { bold: true, color: { argb: 'FFFFFFFF' } },
    fill: {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF1E3A8A' },
    },
    alignment: { horizontal: 'center', vertical: 'middle' },
    border: {
      top: { style: 'thin', color: { argb: 'FF000000' } },
      bottom: { style: 'thin', color: { argb: 'FF000000' } },
      left: { style: 'thin', color: { argb: 'FF000000' } },
      right: { style: 'thin', color: { argb: 'FF000000' } },
    },
  };

  for (let col = 1; col <= 6; col++) {
    const cell = hoja.getCell(1, col);
    cell.style = cabeceraEstilo;
  }

  // Estilo de datos - solo columnas A-F, sin bordes laterales innecesarios
  const datosEstilo: Partial<ExcelJS.Style> = {
    alignment: { horizontal: 'center', vertical: 'middle' },
    border: {
      bottom: { style: 'thin', color: { argb: 'FFD0D0D0' } },
    },
  };

  // Datos
  for (const producto of productos) {
    const row = hoja.addRow({
      codigo: producto.codigo,
      nombre: producto.nombre,
      presentacion_kg: kilosComoTexto(producto.presentacion_kg),
      categoria: producto.categoria ?? '—',
      especie: producto.especie ?? '—',
      activo: producto.activo ? 'Activo' : 'De baja',
    });
    for (let col = 1; col <= 6; col++) {
      row.getCell(col).style = datosEstilo;
    }
  }

  // Auto-ajustar anchos según contenido (mínimo el ancho de cabecera)
  for (const col of hoja.columns) {
    if (col.key) {
      const columna = hoja.getColumn(col.key);
      let maxWidth = col.width ?? 10;
      columna.eachCell({ includeEmpty: false }, (cell) => {
        const valor = String(cell.value ?? '');
        const ancho = Math.max(valor.length + 2, col.width ?? 10);
        if (ancho > maxWidth) maxWidth = ancho;
      });
      columna.width = Math.min(maxWidth, 50); // tope máximo 50
    }
  }

  // Filtro automático solo A-F
  hoja.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: 6 },
  };

  // Congelar primera fila
  hoja.views = [{ state: 'frozen', ySplit: 1 }];

  // Configuración de página: horizontal, ajustar a una página
  hoja.pageSetup = {
    orientation: 'landscape',
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.3, footer: 0.3 },
    printArea: 'A1:F1000',
  };

  // Quitar líneas de cuadrícula para columnas G en adelante (ocultar columnas vacías)
  for (let col = 7; col <= 100; col++) {
    hoja.getColumn(col).hidden = true;
  }

  return Buffer.from(await libro.xlsx.writeBuffer());
}