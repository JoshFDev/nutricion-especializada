import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ToastService } from './toast.service';
import { trigger, transition, style, animate } from '@angular/animations';
import { DomSanitizer, type SafeHtml } from '@angular/platform-browser';

@Component({
  selector: 'app-toast-container',
  standalone: true,
  imports: [CommonModule],
  template: `
    @if (toastService.toasts().length > 0) {
      <div class="toast-container" aria-live="polite" aria-atomic="true">
        @for (toast of toastService.toasts(); track toast.id) {
          <div class="toast" [class]="toast.tipo" [@slideIn]>
            <span class="toast-icon" [innerHTML]="icono(toast.tipo)"></span>
            <span class="toast-mensaje">{{ toast.mensaje }}</span>
            <button type="button" class="toast-cerrar" (click)="toastService.cerrar(toast.id)" aria-label="Cerrar">×</button>
          </div>
        }
      </div>
    }
  `,
  styles: [`
    .toast-container {
      position: fixed;
      top: 1rem;
      right: 1rem;
      z-index: 2000;
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      pointer-events: none;
      max-width: 360px;
    }

    .toast {
      pointer-events: auto;
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.75rem 1rem;
      background: var(--superficie);
      border: 1px solid var(--borde);
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
      font-size: 0.875rem;
      color: var(--texto);
      min-width: 280px;
      max-width: 100%;
    }

    .toast.exito {
      border-left: 4px solid var(--exito-texto);
    }

    .toast.exito .toast-icon {
      color: var(--exito-texto);
    }

    .toast.error {
      border-left: 4px solid var(--peligro);
    }

    .toast.error .toast-icon {
      color: var(--peligro);
    }

    .toast.advertencia {
      border-left: 4px solid var(--advertencia);
    }

    .toast.advertencia .toast-icon {
      color: var(--advertencia-texto);
    }

    .toast.info {
      border-left: 4px solid var(--acento);
    }

    .toast.info .toast-icon {
      color: var(--acento);
    }

    .toast-icon {
      font-size: 1rem;
      font-weight: bold;
      flex-shrink: 0;
    }

    .toast-mensaje {
      flex: 1;
      line-height: 1.4;
    }

    .toast-cerrar {
      background: none;
      border: none;
      color: var(--texto-tenue);
      font-size: 1.25rem;
      line-height: 1;
      cursor: pointer;
      padding: 0;
      width: 24px;
      height: 24px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }

    .toast-cerrar:hover {
      color: var(--texto);
    }

    @keyframes slideIn {
      from {
        opacity: 0;
        transform: translateX(100%);
      }
      to {
        opacity: 1;
        transform: translateX(0);
      }
    }
  `],
  animations: [
    trigger('slideIn', [
      transition(':enter', [
        style({ opacity: 0, transform: 'translateX(100%)' }),
        animate('300ms ease-out', style({ opacity: 1, transform: 'translateX(0)' })),
      ]),
      transition(':leave', [
        animate('200ms ease-in', style({ opacity: 0, transform: 'translateX(100%)' })),
      ]),
    ]),
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ToastContainer {
  private readonly sanitizer = inject(DomSanitizer);
  toastService = inject(ToastService);

  icono(tipo: string): SafeHtml {
    const iconos: Record<string, string> = {
      exito: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`,
      error: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`,
      advertencia: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>`,
      info: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>`,
    };
    return this.sanitizer.bypassSecurityTrustHtml(iconos[tipo] ?? iconos['info']);
  }
}