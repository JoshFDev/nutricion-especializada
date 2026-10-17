import { enviarCorreo } from '../../core/correo.js';
import type { Nota } from './modelo.js';

export async function enviarTicketNota(
  clienteEmail: string,
  clienteNombre: string,
  nota: Nota,
  esCancelada: boolean,
): Promise<void> {
  const subject = esCancelada
    ? `Nota de remisión cancelada - ${nota.folio}`
    : `Nota de remisión - ${nota.folio}`;
  const renglones = nota.renglones
    .map(
      (r) =>
        `- ${r.producto_nombre}: ${r.cantidad_bultos} bultos, ${r.kg_bulto} kg/bulto, $${r.precio_unit_kg.toFixed(2)}/kg = $${r.subtotal.toFixed(2)}`,
    )
    .join('\n');
  const text = `Hola ${clienteNombre},

${esCancelada ? 'Su nota de remisión ha sido cancelada:' : 'Detalle de su nota de remisión:'}

Folio: ${nota.folio}
Fecha: ${nota.fecha}
Dirección de entrega: ${nota.direccion_entrega ?? ''}

Renglones:
${renglones}

Total: $${nota.subtotal.toFixed(2)}

Gracias por su preferencia.`;
  const html = `<p>Hola <strong>${clienteNombre}</strong>,</p>
<p>${esCancelada ? 'Su nota de remisión ha sido cancelada:' : 'Detalle de su nota de remisión:'}</p>
<ul>
  <li><strong>Folio:</strong> ${nota.folio}</li>
  <li><strong>Fecha:</strong> ${nota.fecha}</li>
  <li><strong>Dirección de entrega:</strong> ${nota.direccion_entrega ?? ''}</li>
</ul>
<p><strong>Renglones:</strong></p>
<ul>
${nota.renglones
  .map(
    (r) =>
      `<li>${r.producto_nombre}: ${r.cantidad_bultos} bultos, ${r.kg_bulto} kg/bulto, $${r.precio_unit_kg.toFixed(2)}/kg = $${r.subtotal.toFixed(2)}</li>`,
  )
  .join('')}
</ul>
<p><strong>Total:</strong> $${nota.subtotal.toFixed(2)}</p>
<p>Gracias por su preferencia.</p>`;
  await enviarCorreo({ to: clienteEmail, subject, text, html });
}
