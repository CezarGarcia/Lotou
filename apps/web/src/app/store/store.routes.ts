import { Routes } from '@angular/router';

export const STORE_ROUTES: Routes = [
  {
    path: '',
    title: 'Lotou. Ingressos para shows',
    loadComponent: () => import('./search/show-search.page').then((m) => m.ShowSearchPage),
  },
  {
    path: 'shows/:id',
    title: 'Show | Lotou.',
    loadComponent: () => import('./show/show-detail.page').then((m) => m.ShowDetailPage),
  },
];
