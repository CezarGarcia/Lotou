import { Routes } from '@angular/router';
import { authGuard } from '../core/auth/auth.guard';

/**
 * A loja. A busca e a página do show são públicas; da fila em diante, a
 * compra exige login (o guard leva ao Keycloak e volta para a mesma página).
 */
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
  {
    path: 'shows/:id/fila',
    title: 'Fila virtual | Lotou.',
    canActivate: [authGuard],
    loadComponent: () => import('./queue/queue.page').then((m) => m.QueuePage),
  },
  {
    path: 'shows/:id/comprar/:sectorId',
    title: 'Comprar | Lotou.',
    canActivate: [authGuard],
    loadComponent: () => import('./checkout/checkout.page').then((m) => m.CheckoutPage),
  },
  {
    path: 'reservas/:id',
    title: 'Reserva | Lotou.',
    canActivate: [authGuard],
    loadComponent: () => import('./reservation/reservation.page').then((m) => m.ReservationPage),
  },
  {
    path: 'pedidos/:id',
    title: 'Pedido | Lotou.',
    canActivate: [authGuard],
    loadComponent: () => import('./orders/order.page').then((m) => m.OrderPage),
  },
  {
    // Pública de propósito: abre sem internet e sem login (ADR 37).
    path: 'ingressos-salvos',
    title: 'Ingressos salvos | Lotou.',
    loadComponent: () => import('./wallet/saved-tickets.page').then((m) => m.SavedTicketsPage),
  },
  {
    path: 'meus-ingressos',
    title: 'Meus ingressos | Lotou.',
    canActivate: [authGuard],
    loadComponent: () => import('./orders/my-tickets.page').then((m) => m.MyTicketsPage),
  },
];
