import { ChangeDetectionStrategy, Component } from '@angular/core';

/** A marca: "LOTOU" num recorte amarelo colado torto. */
@Component({
  selector: 'app-logo',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `Lotou`,
  styles: `
    :host {
      display: inline-block;
      padding: 4px 12px 1px;
      background: var(--lt-cta);
      color: var(--lt-on-cta);
      font-family: var(--lt-display);
      font-size: var(--logo-size, 30px);
      font-weight: 900;
      line-height: 1;
      text-transform: uppercase;
      transform: rotate(-2deg);
    }
  `,
})
export class Logo {}
