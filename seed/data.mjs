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

const pista = (capacity, name = 'Pista') => ({
  name,
  kind: 'GENERAL_ADMISSION',
  capacity,
});
const cadeira = (capacity, name) => ({
  name,
  kind: 'RESERVED_SEATING',
  capacity,
});

export const venues = [
  {
    name: 'Arena Paulista',
    address: { street: 'Av. Marquês de São Vicente, 2400', city: 'São Paulo', state: 'SP' },
    timezone: 'America/Sao_Paulo',
    sectors: [
      pista(12_000),
      pista(3_000, 'Pista Premium'),
      cadeira(4_000, 'Cadeira Inferior'),
      cadeira(6_000, 'Cadeira Superior'),
    ],
  },
  {
    name: 'Teatro Guanabara',
    address: { street: 'Rua do Passeio, 98', city: 'Rio de Janeiro', state: 'RJ' },
    timezone: 'America/Sao_Paulo',
    sectors: [cadeira(820, 'Plateia'), cadeira(380, 'Balcão Nobre')],
  },
  {
    name: 'Estádio do Capibaribe',
    address: { street: 'Av. Beira Rio, 1500', city: 'Recife', state: 'PE' },
    timezone: 'America/Recife',
    sectors: [
      pista(18_000),
      pista(14_000, 'Arquibancada'),
      cadeira(5_000, 'Cadeira Coberta'),
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
    sectors: [pista(8_000), cadeira(1_200, 'Mezanino')],
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
  {
    venue: 'Pedreira do Sul',
    title: 'Inverno Elétrico',
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
