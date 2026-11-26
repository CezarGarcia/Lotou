import { Routes } from '@angular/router';

/**
 * Cada área do Lotou é carregada sob demanda. Hoje existe a loja; o painel do
 * produtor e a portaria entram como rotas irmãs.
 */
export const routes: Routes = [
  {
    path: '',
    loadChildren: () => import('./store/store.routes').then((m) => m.STORE_ROUTES),
  },
  { path: '**', redirectTo: '' },
];
