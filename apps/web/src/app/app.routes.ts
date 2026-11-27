import { Routes } from '@angular/router';

/**
 * Cada área do Lotou é carregada sob demanda: a loja e o painel do produtor.
 * A portaria entra como rota irmã.
 */
export const routes: Routes = [
  {
    path: 'painel',
    loadChildren: () => import('./producer/producer.routes').then((m) => m.PRODUCER_ROUTES),
  },
  {
    path: '',
    loadChildren: () => import('./store/store.routes').then((m) => m.STORE_ROUTES),
  },
  { path: '**', redirectTo: '' },
];
