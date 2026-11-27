import { DOCUMENT } from '@angular/common';
import { Injectable, computed, effect, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router } from '@angular/router';
import { filter, map } from 'rxjs';

/** As três áreas do Lotou, cada uma com o seu cabeçalho e tema. */
export type Area = 'loja' | 'painel' | 'portaria';

/**
 * A área da rota atual e o que depende dela:
 * - o tema (noite na loja e na portaria, dia no painel), como classe no `<html>`,
 *   para os overlays do Material (diálogos, menus) seguirem o mesmo tema;
 * - o modo foco do leitor da portaria, sem cabeçalho nem rodapé;
 * - a barra de abas da loja no celular, só nas telas de navegação (nas de
 *   compra, a barra de pagamento fica no lugar dela).
 */
@Injectable({ providedIn: 'root' })
export class AppArea {
  private readonly router = inject(Router);
  private readonly document = inject(DOCUMENT);

  private readonly url = toSignal(
    this.router.events.pipe(
      filter((event) => event instanceof NavigationEnd),
      map((event) => event.urlAfterRedirects),
    ),
    { initialValue: this.router.url },
  );

  private readonly path = computed(() => this.url().split(/[?#]/)[0]);

  readonly area = computed<Area>(() => {
    const path = this.path();
    if (path.startsWith('/painel')) {
      return 'painel';
    }
    return path.startsWith('/portaria') ? 'portaria' : 'loja';
  });

  readonly theme = computed(() => (this.area() === 'painel' ? 'dia' : 'noite'));

  /** O leitor de ingressos ocupa a tela inteira. */
  readonly focus = computed(() => /^\/portaria\/shows\/[^/]+/.test(this.path()));

  /** A página dos ingressos salvos já explica que o aparelho está sem internet. */
  readonly savedTickets = computed(() => this.path().startsWith('/ingressos-salvos'));

  /** A barra de abas do celular aparece na vitrine e nos ingressos. */
  readonly tabs = computed(() => {
    const path = this.path();
    return (
      path === '/' ||
      path === '' ||
      path.startsWith('/meus-ingressos') ||
      path.startsWith('/ingressos-salvos')
    );
  });

  constructor() {
    effect(() => {
      const theme = this.theme();
      const root = this.document.documentElement;
      root.classList.toggle('tema-dia', theme === 'dia');
      root.classList.toggle('tema-noite', theme === 'noite');
    });
  }
}
