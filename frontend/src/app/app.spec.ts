import { TestBed } from '@angular/core/testing';
import { App } from './app';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
    }).compileComponents();
  });

  it('crea la app', () => {
    const fixture = TestBed.createComponent(App);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('no pinta nada por su cuenta, solo el hueco del router', () => {
    // La raiz es un `router-outlet` y ya. Si esto se cumple, la pantalla
    // que se ve depende solo de la ruta, y recargar en `/notas` no pierde
    // nada.
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();

    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('router-outlet')).toBeTruthy();
    expect(compiled.textContent?.trim()).toBe('');
  });
});
