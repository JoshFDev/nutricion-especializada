import { enviarCorreo } from '../../core/correo.js';
import { escaparHtml } from '../../core/correo-marca.js';
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

  /**
   * Todo lo que va al cuerpo HTML se escapa.
   *
   * El nombre del cliente, la direccion de entrega y el nombre del
   * producto los captura el personal en el mostrador, asi que no hace
   * falta ser un atacante para que acaben con un `<b>` o con una etiqueta
   * con un `onerror` dentro. En el visor de correo eso es HTML
   * arbitrario, y un `<img src="http://...">` confirma la direccion de
   * correo de quien lo recibe.
   *
   * `escaparHtml` ya existia y lo usan los correos de auth y de usuarios;
   * este se habia quedado atras.
   */
  const html = `<p>Hola <strong>${escaparHtml(clienteNombre)}</strong>,</p>
<p>${esCancelada ? 'Su nota de remisión ha sido cancelada:' : 'Detalle de su nota de remisión:'}</p>
<ul>
  <li><strong>Folio:</strong> ${escaparHtml(nota.folio)}</li>
  <li><strong>Fecha:</strong> ${escaparHtml(nota.fecha)}</li>
  <li><strong>Dirección de entrega:</strong> ${escaparHtml(nota.direccion_entrega ?? '')}</li>
</ul>
<p><strong>Renglones:</strong></p>
<ul>
${nota.renglones
  .map(
    (r) =>
      `<li>${escaparHtml(r.producto_nombre)}: ${r.cantidad_bultos} bultos, ${r.kg_bulto} kg/bulto, $${r.precio_unit_kg.toFixed(2)}/kg = $${r.subtotal.toFixed(2)}</li>`,
  )
  .join('')}
</ul>
<p><strong>Total:</strong> $${nota.subtotal.toFixed(2)}</p>
<p>Gracias por su preferencia.</p>`;
  await enviarCorreo({ to: clienteEmail, subject, text, html });
}
