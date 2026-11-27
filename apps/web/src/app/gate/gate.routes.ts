import { Routes } from '@angular/router';
import { gateGuard } from './gate.guard';

/**
 * Portaria, carregada sob demanda como o painel do produtor: nada dela (nem o
 * leitor de QR) entra no pacote da loja. Exige o papel `gate-staff`.
 */
export const GATE_ROUTES: Routes = [
  {
    path: 'sem-acesso',
    title: 'Acesso restrito | Lotou.',
    loadComponent: () => import('../shared/no-access.page').then((m) => m.NoAccessPage),
    data: { message: 'A portaria é só para a equipe dos portões. Sua conta não tem esse acesso.' },
  },
  {
    path: '',
    canActivateChild: [gateGuard],
    children: [
      {
        path: '',
        title: 'Portaria | Lotou.',
        loadComponent: () => import('./gate-setup.page').then((m) => m.GateSetupPage),
      },
      {
        path: 'shows/:showId',
        title: 'Leitor | Portaria Lotou.',
        loadComponent: () => import('./scanner/gate-scanner.page').then((m) => m.GateScannerPage),
      },
    ],
  },
];
