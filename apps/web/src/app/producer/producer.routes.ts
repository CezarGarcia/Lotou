import { Routes } from '@angular/router';
import { producerGuard } from './producer.guard';

/**
 * Área do produtor, carregada sob demanda: nada dela entra no pacote da loja.
 * Todas as telas, menos a de acesso restrito, exigem o papel `producer`. Cada
 * show tem três abas: Ao vivo, Financeiro e Cupons.
 */
export const PRODUCER_ROUTES: Routes = [
  {
    path: 'sem-acesso',
    title: 'Acesso restrito | Lotou.',
    loadComponent: () => import('../shared/no-access.page').then((m) => m.NoAccessPage),
    data: { message: 'O painel é só para produtores. Sua conta não tem esse acesso.' },
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
        // A moldura com o cabeçalho do show e as abas; cada aba é uma rota filha.
        path: 'shows/:id',
        loadComponent: () => import('./show/show-shell.page').then((m) => m.ShowShellPage),
        children: [
          {
            path: '',
            title: 'Ao vivo | Painel Lotou.',
            loadComponent: () => import('./live/live-show.page').then((m) => m.LiveShowPage),
          },
          {
            path: 'financeiro',
            title: 'Financeiro | Painel Lotou.',
            loadComponent: () => import('./finance/finance.page').then((m) => m.FinancePage),
          },
          {
            path: 'cupons',
            title: 'Cupons | Painel Lotou.',
            loadComponent: () => import('./coupons/coupons.page').then((m) => m.CouponsPage),
          },
        ],
      },
    ],
  },
];
