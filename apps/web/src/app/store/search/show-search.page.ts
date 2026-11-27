import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { Router } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCloudOff,
  lucideMapPin,
  lucideMicVocal,
  lucideSearch,
  lucideSearchX,
  lucideX,
} from '@ng-icons/lucide';
import { ShowFilters } from '../data/show.models';
import { injectNow } from '../shared/countdown';
import { FeaturedShow } from './featured-show';
import { ShowCard } from './show-card';
import { ShowSearchStore } from './show-search.store';
import { TonightCard } from './tonight-card';
import { QuickPeriod, isToday, pickFeatured, quickPeriods, resultsSummary } from './vitrine';
import { WhyLotou } from './why-lotou';

/**
 * Página inicial da loja: o show em destaque, a busca por artista, cidade e
 * data, os shows de hoje e a vitrine dos próximos.
 *
 * Os filtros moram na URL (`/?city=Recife`): o formulário e os filtros
 * rápidos só navegam, e a busca reage aos parâmetros. Assim o link de uma
 * busca pode ser compartilhado e o botão voltar do navegador funciona. Com
 * algum filtro ativo, o destaque e "Hoje à noite" dão lugar ao resultado.
 */
@Component({
  selector: 'app-show-search-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ReactiveFormsModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    MatProgressBarModule,
    NgIcon,
    FeaturedShow,
    ShowCard,
    TonightCard,
    WhyLotou,
  ],
  viewProviders: [
    provideIcons({
      lucideCloudOff,
      lucideMapPin,
      lucideMicVocal,
      lucideSearch,
      lucideSearchX,
      lucideX,
    }),
  ],
  providers: [ShowSearchStore],
  templateUrl: './show-search.page.html',
  styleUrl: './show-search.page.scss',
})
export class ShowSearchPage {
  private readonly router = inject(Router);
  protected readonly store = inject(ShowSearchStore);
  private readonly now = injectNow(60_000);

  // Parâmetros de query, ligados pelo roteador.
  readonly artist = input<string>();
  readonly city = input<string>();
  readonly from = input<string>();
  readonly to = input<string>();

  protected readonly form = inject(FormBuilder).nonNullable.group({
    artist: '',
    city: '',
    from: '',
    to: '',
  });

  protected readonly skeletons = Array.from({ length: 8 });

  protected readonly hasFilters = computed(() =>
    Object.values(this.store.filters()).some((value) => value !== ''),
  );

  /** Shows de hoje, no fuso de cada um. Só na vitrine sem filtros. */
  protected readonly tonight = computed(() =>
    this.hasFilters()
      ? []
      : this.store.shows().filter((show) => isToday(show, new Date(this.now()))),
  );

  protected readonly featured = computed(() =>
    this.hasFilters() ? null : pickFeatured(this.store.shows(), new Date(this.now())),
  );

  /** A grade: sem filtros, os shows de hoje já estão na faixa deles. */
  protected readonly grid = computed(() => {
    const tonight = new Set(this.tonight().map((show) => show.id));
    return this.store.shows().filter((show) => !tonight.has(show.id));
  });

  protected readonly summary = computed(() => resultsSummary(this.grid()));

  protected readonly periods = computed(() => quickPeriods(new Date(this.now())));

  protected readonly activePeriod = computed(() => {
    const { from, to } = this.store.filters();
    return this.periods().find((period) => period.from === from && period.to === to)?.id;
  });

  /**
   * As cidades dos filtros rápidos: as que já apareceram nos resultados. Com
   * uma cidade escolhida, o resultado só tem ela; as outras continuam ali
   * para trocar de cidade com um toque.
   */
  private readonly seenCities = signal<string[]>([]);
  protected readonly cities = computed(() => {
    const active = this.store.filters().city;
    const all = new Set(this.seenCities());
    if (active) {
      all.add(active);
    }
    return [...all].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  });

  constructor() {
    // A URL é a fonte da verdade: quando ela muda, o formulário e a busca acompanham.
    effect(() => {
      const filters: ShowFilters = {
        artist: this.artist() ?? '',
        city: this.city() ?? '',
        from: this.from() ?? '',
        to: this.to() ?? '',
      };
      this.form.setValue(filters);
      this.store.search(filters);
    });

    effect(() => {
      const found = this.store.shows().flatMap((show) => (show.venue ? [show.venue.city] : []));
      this.seenCities.update((cities) => {
        const merged = new Set([...cities, ...found]);
        return merged.size === cities.length ? cities : [...merged];
      });
    });
  }

  protected get invalidPeriod(): boolean {
    const { from, to } = this.form.getRawValue();
    return from !== '' && to !== '' && from > to;
  }

  protected submit(): void {
    if (this.invalidPeriod) {
      return;
    }
    this.navigate(this.form.getRawValue());
  }

  protected clear(): void {
    void this.router.navigate([], { queryParams: {} });
  }

  /** Liga ou desliga um período, sem mexer no artista e na cidade. */
  protected togglePeriod(period: QuickPeriod): void {
    const active = this.activePeriod() === period.id;
    this.navigate({
      ...this.store.filters(),
      from: active ? '' : period.from,
      to: active ? '' : period.to,
    });
  }

  protected toggleCity(city: string): void {
    const filters = this.store.filters();
    this.navigate({ ...filters, city: filters.city === city ? '' : city });
  }

  private navigate(filters: ShowFilters): void {
    const queryParams = Object.fromEntries(
      Object.entries(filters)
        .map(([name, value]) => [name, value.trim()])
        .filter(([, value]) => value !== ''),
    );
    void this.router.navigate([], { queryParams });
  }
}
