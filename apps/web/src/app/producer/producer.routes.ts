import { Routes } from '@angular/router';
import { producerGuard } from './producer.guard';

/**
 * Área do produtor, carregada sob demanda: nada dela entra no pacote da loja.
 * Todas as telas, menos a de acesso restrito, exigem o papel `producer`.
 */
export const PRODUCER_ROUTES: Routes = [
  {
    path: 'sem-acesso',
    title: 'Acesso restrito | Lotou.',
    loadComponent: () => import('./no-access.page').then((m) => m.NoAccessPage),
  },
  {
    path: '',
    canActivateChild: [producerGuard],
    children: [
      {
        path: '',
        title: 'Meus shows | Painel Lotou.',
        loadComponent: () => import('./shows/producer-shows.page').then((m) => m.ProducerShowsPage),
      },
      {
        path: 'shows/:id',
        title: 'Ao vivo | Painel Lotou.',
        loadComponent: () => import('./live/live-show.page').then((m) => m.LiveShowPage),
      },
    ],
  },
];
