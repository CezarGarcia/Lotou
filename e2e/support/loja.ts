import { expect, type Page } from '@playwright/test';
import { cpfAleatorio } from './dados';

/*
 * Passos da compra na loja, repetidos por mais de um cenário. Cada um termina
 * conferindo que chegou à tela seguinte.
 */

const KIND = '(Sem lugar marcado|Lugar marcado)';

/**
 * Da página do show ao checkout do setor. Sem a sessão do app, o botão leva ao
 * Keycloak, que reconhece o cookie da sessão gravado pelo setup e devolve o
 * comprador direto ao checkout, sem pedir a senha de novo.
 */
export async function abrirCheckout(page: Page, showId: string, setor: string): Promise<void> {
  await page.goto(`/shows/${showId}`);
  await page.getByRole('radio', { name: new RegExp(`^${setor} ${KIND}`) }).check();
  await page.getByRole('button', { name: 'Comprar ingressos' }).click();
  await page.waitForURL(new RegExp(`/shows/${showId}/comprar/`));
  await expect(page.getByRole('heading', { level: 2, name: setor })).toBeVisible();
}

/** Informa um CPF novo e reserva; devolve o id da reserva, que está na URL da tela seguinte. */
export async function reservar(page: Page): Promise<string> {
  await page.getByLabel('CPF de quem compra').fill(cpfAleatorio());
  await page.getByRole('button', { name: 'Reservar', exact: true }).click();
  await page.waitForURL(/\/reservas\/[0-9a-f-]+$/);
  await expect(page.getByText('Sua reserva expira em')).toBeVisible();
  return page.url().split('/').pop()!;
}

/**
 * Paga a reserva aberta na tela e espera a saga confirmar o pedido (o
 * pagamento simulado leva alguns segundos). Devolve o id do pedido.
 */
export async function pagar(page: Page): Promise<string> {
  await page.getByRole('button', { name: /^Pagar R\$/ }).click();
  await page.waitForURL(/\/pedidos\/[0-9a-f-]+$/);
  await expect(page.getByRole('heading', { name: 'Compra confirmada!' })).toBeVisible({
    timeout: 45_000,
  });
  return page.url().split('/').pop()!;
}

/** O QR code de cada ingresso do pedido, desenhado na tela. */
export function qrDosIngressos(page: Page) {
  return page.getByRole('img', { name: /^QR code do ingresso/ });
}
