import { Injectable, signal, type WritableSignal } from '@angular/core';

export type ToastTipo = 'exito' | 'error' | 'advertencia' | 'info';

export interface Toast {
  id: number;
  mensaje: string;
  tipo: ToastTipo;
}

@Injectable({ providedIn: 'root' })
export class ToastService {
  private readonly _toasts: WritableSignal<Toast[]> = signal([]);
  private _contador = 0;

  readonly toasts = this._toasts.asReadonly();

  exito(mensaje: string): void {
    this.agregar(mensaje, 'exito');
  }

  error(mensaje: string): void {
    this.agregar(mensaje, 'error');
  }

  advertencia(mensaje: string): void {
    this.agregar(mensaje, 'advertencia');
  }

  info(mensaje: string): void {
    this.agregar(mensaje, 'info');
  }

  private agregar(mensaje: string, tipo: ToastTipo): void {
    const id = ++this._contador;
    const toast: Toast = { id, mensaje, tipo };
    this._toasts.update((actuales) => [...actuales, toast]);
    setTimeout(() => this.cerrar(id), 4000);
  }

  cerrar(id: number): void {
    this._toasts.update((actuales) => actuales.filter((t) => t.id !== id));
  }

  limpiar(): void {
    this._toasts.set([]);
  }
}