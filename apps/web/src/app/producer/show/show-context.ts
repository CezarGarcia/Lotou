import { httpResource } from '@angular/common/http';
import { Injectable, computed, signal } from '@angular/core';
import { Show } from '../../store/data/show.models';
import { SHOWS_URL } from '../../store/data/shows.api';

/**
 * O show aberto no painel, compartilhado pelas abas (Ao vivo, Financeiro,
 * Cupons). A moldura das abas define o ID; as abas leem daqui o documento do
 * catálogo (artista, fuso, setores) sem buscar de novo.
 */
@Injectable()
export class ProducerShowContext {
  readonly id = signal<string | null>(null);

  readonly show = httpResource<Show>(() => {
    const id = this.id();
    return id ? `${SHOWS_URL}/${id}` : undefined;
  });

  readonly value = computed(() => (this.show.hasValue() ? this.show.value() : null));
  /** Fuso do local: todas as datas do painel aparecem nele. */
  readonly timezone = computed(() => this.value()?.venue?.timezone);
  readonly sectors = computed(() => this.value()?.sectors ?? []);
}
