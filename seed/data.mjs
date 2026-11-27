/**
 * Dados fictícios do Lotou: locais e shows inventados, mas críveis.
 *
 * As datas são relativas ao dia em que o seed roda, para a loja sempre ter
 * shows futuros, um com as vendas abertas e outro em contagem regressiva.
 */

// Todos os locais do seed ficam em fusos que hoje valem UTC-3.
const OFFSET = '-03:00';

/** Daqui a `days` dias, no horário local `time` (HH:MM). */
export function at(days, time) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return `${date.toISOString().slice(0, 10)}T${time}:00${OFFSET}`;
}

/** Daqui a `hours` horas, na hora cheia (o seed repetido na mesma hora manda o mesmo corpo). */
function inHours(hours) {
  const date = new Date();
  date.setUTCMinutes(0, 0, 0);
  date.setUTCHours(date.getUTCHours() + hours);
  return date.toISOString();
}

/**
 * O show de hoje vai até o fim do dia no fuso dos locais (23h, UTC-3), ou pelo
 * menos 3 horas depois do seed, se ele rodar tarde da noite: a portaria e as
 * vendas ficam abertas o dia todo, não só nas horas seguintes ao seed.
 */
function tonight() {
  const local = new Date(Date.now() - 3 * 3_600_000);
  const endOfDay = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), 23 + 3, 30);
  const startsAt = Math.max(endOfDay, Date.now() + 3 * 3_600_000);
  const hour = (ms) => new Date(Math.floor(ms / 3_600_000) * 3_600_000).toISOString();
  return { startsAt: hour(startsAt), salesEndAt: hour(startsAt - 3_600_000) };
}

/** A data de hoje no fuso dos locais (UTC-3), como DD/MM. */
function todayLabel() {
  const local = new Date(Date.now() - 3 * 3_600_000).toISOString();
  return `${local.slice(8, 10)}/${local.slice(5, 7)}`;
}

const pista = (capacity, name = 'Pista') => ({
  name,
  kind: 'GENERAL_ADMISSION',
  capacity,
});

/** Rótulo da fileira: A, B... Z, AA, AB... (como colunas de planilha). */
const rowLabel = (index) => {
  let label = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    label = String.fromCharCode(65 + ((n - 1) % 26)) + label;
  }
  return label;
};

/** Setor de cadeira numerada: `rows` fileiras de `seatsPerRow` cadeiras. */
const cadeira = (name, rows, seatsPerRow) => ({
  name,
  kind: 'RESERVED_SEATING',
  capacity: rows * seatsPerRow,
  rows: Array.from({ length: rows }, (_, index) => ({
    label: rowLabel(index),
    seatCount: seatsPerRow,
  })),
});

export const venues = [
  {
    name: 'Arena Paulista',
    address: { street: 'Av. Marquês de São Vicente, 2400', city: 'São Paulo', state: 'SP' },
    timezone: 'America/Sao_Paulo',
    sectors: [
      pista(12_000),
      pista(3_000, 'Pista Premium'),
      cadeira('Cadeira Inferior', 80, 50),
      cadeira('Cadeira Superior', 120, 50),
    ],
  },
  {
    name: 'Teatro Guanabara',
    address: { street: 'Rua do Passeio, 98', city: 'Rio de Janeiro', state: 'RJ' },
    timezone: 'America/Sao_Paulo',
    sectors: [cadeira('Plateia', 20, 41), cadeira('Balcão Nobre', 10, 38)],
  },
  {
    name: 'Estádio do Capibaribe',
    address: { street: 'Av. Beira Rio, 1500', city: 'Recife', state: 'PE' },
    timezone: 'America/Recife',
    sectors: [
      pista(18_000),
      pista(14_000, 'Arquibancada'),
      cadeira('Cadeira Coberta', 100, 50),
    ],
  },
  {
    name: 'Hangar Ver-o-Rio',
    address: { street: 'Av. Marechal Hermes, 310', city: 'Belém', state: 'PA' },
    timezone: 'America/Belem',
    sectors: [pista(5_000), pista(600, 'Camarote')],
  },
  {
    name: 'Pedreira do Sul',
    address: { street: 'Rua das Araucárias, 77', city: 'Curitiba', state: 'PR' },
    timezone: 'America/Sao_Paulo',
    sectors: [pista(8_000), cadeira('Mezanino', 30, 40)],
  },
];

/** Um lote; o preço é informado em reais e gravado em centavos. */
const lot = (name, reais, quantity) => ({
  name,
  priceCents: Math.round(reais * 100),
  quantity,
});

export const shows = [
  {
    venue: 'Arena Paulista',
    title: 'Turnê Horizonte',
    coupon: { code: 'HORIZONTE15', kind: 'PERCENT', percent: 15, maxUses: 200 },
    artist: 'Marina Céu',
    description:
      'A maior turnê da carreira de Marina Céu chega a São Paulo com o repertório do álbum Horizonte, banda completa e participações especiais. Abertura de vendas com fila virtual.',
    startsAt: at(45, '21:00'),
    doorsOpenAt: at(45, '17:00'),
    // Vendas ainda fechadas: a página do show mostra a contagem regressiva.
    salesStartAt: at(3, '10:00'),
    salesEndAt: at(45, '18:00'),
    highDemand: true,
    sectors: {
      Pista: [lot('1º lote', 180, 5_000), lot('2º lote', 220, 4_000), lot('3º lote', 260, 3_000)],
      'Pista Premium': [lot('1º lote', 420, 1_500), lot('2º lote', 480, 1_500)],
      'Cadeira Inferior': [lot('Lote único', 350, 4_000)],
      'Cadeira Superior': [lot('1º lote', 140, 3_000), lot('2º lote', 170, 3_000)],
    },
  },
  {
    venue: 'Teatro Guanabara',
    title: 'Vinte Anos de Estrada',
    coupon: { code: 'ESTRADA20', kind: 'AMOUNT', amountCents: 2_000, maxUses: 100 },
    artist: 'Os Tropicais do Asfalto',
    description:
      'Show acústico de aniversário, com os sucessos dos vinte anos da banda em arranjos novos para o palco do Teatro Guanabara.',
    startsAt: at(20, '20:30'),
    doorsOpenAt: at(20, '19:00'),
    salesStartAt: at(-5, '12:00'),
    salesEndAt: at(20, '19:00'),
    highDemand: false,
    sectors: {
      Plateia: [lot('1º lote', 160, 400), lot('2º lote', 190, 420)],
      'Balcão Nobre': [lot('Lote único', 120, 380)],
    },
  },
  {
    venue: 'Estádio do Capibaribe',
    title: 'Maracatu Elétrico ao Vivo',
    coupon: { code: 'MARACATU10', kind: 'PERCENT', percent: 10, maxUses: 500 },
    artist: 'Nação Coral',
    description:
      'Tambores de maracatu, guitarras e metais numa noite só. A Nação Coral grava seu primeiro álbum ao vivo no Estádio do Capibaribe.',
    startsAt: at(60, '20:00'),
    doorsOpenAt: at(60, '16:00'),
    salesStartAt: at(-2, '10:00'),
    salesEndAt: at(60, '17:00'),
    highDemand: true,
    sectors: {
      Pista: [lot('1º lote', 90, 8_000), lot('2º lote', 120, 6_000), lot('3º lote', 150, 4_000)],
      Arquibancada: [lot('1º lote', 60, 7_000), lot('2º lote', 80, 7_000)],
      'Cadeira Coberta': [lot('Lote único', 210, 5_000)],
    },
  },
  {
    venue: 'Hangar Ver-o-Rio',
    title: 'Baile da Maré Cheia',
    coupon: { code: 'MARE10', kind: 'PERCENT', percent: 10, maxUses: 100 },
    artist: 'Orquestra Ribeirinha',
    description:
      'Carimbó, guitarrada e brega num baile de quatro horas, com a Orquestra Ribeirinha e convidados da cena de Belém.',
    startsAt: at(30, '22:00'),
    doorsOpenAt: at(30, '20:00'),
    salesStartAt: at(-10, '09:00'),
    salesEndAt: at(30, '21:00'),
    highDemand: false,
    sectors: {
      Pista: [lot('1º lote', 50, 2_500), lot('2º lote', 70, 2_500)],
      Camarote: [lot('Lote único', 180, 600)],
    },
  },
  // Um show acontecendo hoje, com os portões já abertos: é o que a portaria lê.
  // O título leva a data, para cada dia de seed ter o seu.
  {
    venue: 'Hangar Ver-o-Rio',
    title: `Ensaio Aberto ${todayLabel()}`,
    artist: 'Coletivo Pé de Serra',
    description:
      'Ensaio aberto do Coletivo Pé de Serra, com forró, xote e baião. Portões já abertos: o show da demonstração da portaria.',
    startsAt: tonight().startsAt,
    doorsOpenAt: inHours(-1),
    salesStartAt: inHours(-48),
    salesEndAt: tonight().salesEndAt,
    highDemand: false,
    sectors: {
      Pista: [lot('Lote único', 40, 2_000)],
      Camarote: [lot('Lote único', 120, 200)],
    },
  },
  {
    venue: 'Pedreira do Sul',
    title: 'Inverno Elétrico',
    coupon: { code: 'INVERNO25', kind: 'PERCENT', percent: 25, maxUses: 50 },
    artist: 'Quinteto Vento Sul',
    description:
      'Rock instrumental ao ar livre na Pedreira do Sul. O Quinteto Vento Sul apresenta o disco Inverno Elétrico na íntegra.',
    startsAt: at(75, '19:30'),
    doorsOpenAt: at(75, '17:30'),
    salesStartAt: at(10, '12:00'),
    salesEndAt: at(75, '18:00'),
    highDemand: false,
    sectors: {
      Pista: [lot('1º lote', 110, 4_000), lot('2º lote', 140, 4_000)],
      Mezanino: [lot('Lote único', 240, 1_200)],
    },
  },
];
