/** Rótulos em português dos estados que o painel mostra. */

export const SHOW_STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Rascunho',
  PUBLISHED: 'Publicado',
  ON_SALE: 'À venda',
  SALES_CLOSED: 'Vendas encerradas',
  FINISHED: 'Realizado',
  CANCELLED: 'Cancelado',
};

export const LOT_STATUS_LABELS: Record<string, string> = {
  SCHEDULED: 'Agendado',
  ON_SALE: 'Em venda',
  SOLD_OUT: 'Esgotado',
  PAUSED: 'Pausado',
  CLOSED: 'Encerrado',
};

/** O rótulo, ou o próprio valor quando o estado é novo para a loja. */
export const label = (labels: Record<string, string>, value: string): string =>
  labels[value] ?? value;
