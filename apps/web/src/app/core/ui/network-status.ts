import { DOCUMENT } from '@angular/common';
import { DestroyRef, Injectable, inject, signal } from '@angular/core';

/**
 * Se o aparelho está com internet, pelo que o navegador sabe
 * (`navigator.onLine` e os eventos `online`/`offline`). O navegador só tem
 * certeza do "sem internet": "online" quer dizer que há rede, não que o
 * servidor responde.
 */
@Injectable({ providedIn: 'root' })
export class NetworkStatus {
  private readonly window = inject(DOCUMENT).defaultView;
  private readonly state = signal(this.window?.navigator.onLine ?? true);

  readonly online = this.state.asReadonly();

  constructor() {
    const update = () => this.state.set(this.window?.navigator.onLine ?? true);
    this.window?.addEventListener('online', update);
    this.window?.addEventListener('offline', update);
    inject(DestroyRef).onDestroy(() => {
      this.window?.removeEventListener('online', update);
      this.window?.removeEventListener('offline', update);
    });
  }
}
