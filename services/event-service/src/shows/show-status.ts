/** Estados do show, com os nomes da seção "Estados" de docs/projeto.md. */
export const SHOW_STATUSES = [
  'DRAFT',
  'PUBLISHED',
  'ON_SALE',
  'SALES_CLOSED',
  'FINISHED',
  'CANCELLED',
] as const;
export type ShowStatus = (typeof SHOW_STATUSES)[number];

/**
 * Tabela única de transições do show. Toda mudança de estado passa por ela;
 * o que não está aqui é recusado.
 */
export const SHOW_TRANSITIONS: Readonly<
  Record<ShowStatus, readonly ShowStatus[]>
> = {
  DRAFT: ['PUBLISHED'],
  PUBLISHED: ['ON_SALE', 'CANCELLED'],
  ON_SALE: ['SALES_CLOSED', 'CANCELLED'],
  SALES_CLOSED: ['FINISHED'],
  FINISHED: [],
  CANCELLED: [],
};

export const canTransition = (from: ShowStatus, to: ShowStatus): boolean =>
  SHOW_TRANSITIONS[from].includes(to);

/** Estados em que o show aparece na loja. Rascunho só o dono vê. */
export const LISTED_STATUSES: readonly ShowStatus[] = [
  'PUBLISHED',
  'ON_SALE',
  'SALES_CLOSED',
];

/**
 * Estados em que o produtor ainda edita o show. Depois que as vendas abrem, a
 * edição depende do que já foi vendido, regra que chega com o inventory.
 */
export const EDITABLE_STATUSES: readonly ShowStatus[] = ['DRAFT', 'PUBLISHED'];
