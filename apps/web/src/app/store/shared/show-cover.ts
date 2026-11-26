import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/** Um número estável a partir de um texto (o mesmo artista, a mesma cor). */
function hash(text: string): number {
  let value = 0;
  for (const char of text) {
    value = (value * 31 + char.codePointAt(0)!) % 360;
  }
  return value;
}

/**
 * Capa do show. Os shows do seed são fictícios e não têm foto, então a capa é
 * um degradê gerado a partir do nome do artista, com as iniciais dele.
 */
@Component({
  selector: 'app-show-cover',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<span class="initials" aria-hidden="true">{{ initials() }}</span>`,
  host: { '[style.background]': 'background()' },
  styles: `
    :host {
      display: grid;
      place-items: center;
      width: 100%;
      height: 100%;
      overflow: hidden;
      container-type: inline-size;
    }
    .initials {
      font-size: clamp(2.5rem, 22cqi, 7rem);
      font-weight: 800;
      letter-spacing: -0.04em;
      line-height: 1;
      color: rgb(255 255 255 / 0.9);
      text-shadow: 0 2px 24px rgb(0 0 0 / 0.25);
      user-select: none;
    }
  `,
})
export class ShowCover {
  readonly artist = input.required<string>();

  protected readonly initials = computed(() =>
    this.artist()
      .split(/\s+/)
      .filter((word) => word.length > 2)
      .slice(0, 2)
      .map((word) => word[0].toUpperCase())
      .join(''),
  );

  protected readonly background = computed(() => {
    const hue = hash(this.artist());
    return `linear-gradient(135deg, hsl(${hue} 70% 42%), hsl(${(hue + 50) % 360} 75% 28%))`;
  });
}
