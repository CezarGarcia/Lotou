import { ChangeDetectionStrategy, Component, effect, inject, input } from '@angular/core';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { Router } from '@angular/router';
import { ShowFilters } from '../data/show.models';
import { ShowCard } from './show-card';
import { ShowSearchStore } from './show-search.store';

/**
 * Busca de shows por artista, cidade e data.
 *
 * Os filtros moram na URL (`/?city=Recife`): o formulário só navega, e a busca
 * reage aos parâmetros. Assim o link de uma busca pode ser compartilhado e o
 * botão voltar do navegador funciona.
 */
@Component({
  selector: 'app-show-search-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ReactiveFormsModule,
    MatButtonModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatProgressBarModule,
    ShowCard,
  ],
  providers: [ShowSearchStore],
  templateUrl: './show-search.page.html',
  styleUrl: './show-search.page.scss',
})
export class ShowSearchPage {
  private readonly router = inject(Router);
  protected readonly store = inject(ShowSearchStore);

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

  protected readonly skeletons = Array.from({ length: 6 });

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
  }

  protected get invalidPeriod(): boolean {
    const { from, to } = this.form.getRawValue();
    return from !== '' && to !== '' && from > to;
  }

  protected get hasFilters(): boolean {
    return Object.values(this.store.filters()).some((value) => value !== '');
  }

  protected submit(): void {
    if (this.invalidPeriod) {
      return;
    }
    const queryParams = Object.fromEntries(
      Object.entries(this.form.getRawValue())
        .map(([name, value]) => [name, value.trim()])
        .filter(([, value]) => value !== ''),
    );
    void this.router.navigate([], { queryParams });
  }

  protected clear(): void {
    void this.router.navigate([], { queryParams: {} });
  }
}
