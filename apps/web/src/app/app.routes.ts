import { Routes } from '@angular/router';

/**
 * Cada área do Lotou é carregada sob demanda: a loja, o painel do produtor e a
 * portaria.
 */
export const routes: Routes = [
  {
    path: 'painel',
    loadChildren: () => import('./producer/producer.routes').then((m) => m.PRODUCER_ROUTES),
  },
  {
    path: 'portaria',
    loadChildren: () => import('./gate/gate.routes').then((m) => m.GATE_ROUTES),
  },
  {
    path: '',
    loadChildren: () => import('./store/store.routes').then((m) => m.STORE_ROUTES),
  },
  { path: '**', redirectTo: '' },
];
