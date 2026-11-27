import { activitySentence, announcement, describeActivity, relativeTime } from './activity-text';
import { ActivityEntry } from './live.protocol';
import { confirmedEntry } from './live.testing';

// O Intl separa "R$" do valor com um espaço não separável.
const plain = (text: string) => text.replace(/ /g, ' ');

const base = { id: '1-0', eventId: 'e', at: '2026-11-26T18:00:00Z' };

describe('describeActivity', () => {
  it('descreve cada tipo de entrada em português, com dinheiro em reais', () => {
    const cases: [ActivityEntry, string, string][] = [
      [
        {
          ...base,
          type: 'OrderConfirmed',
          orderId: 'o',
          sectorName: 'Pista',
          quantity: 2,
          totalCents: 30_000,
        },
        'Pedido confirmado',
        '2 ingressos em Pista · R$ 300,00',
      ],
      [
        {
          ...base,
          type: 'OrderConfirmed',
          orderId: 'o',
          sectorName: 'Camarote',
          quantity: 1,
          totalCents: 45_050,
        },
        'Pedido confirmado',
        '1 ingresso em Camarote · R$ 450,50',
      ],
      [
        {
          ...base,
          type: 'OrderCancelled',
          orderId: 'o',
          reason: 'PAYMENT_DECLINED',
          totalCents: 15_000,
        },
        'Pedido cancelado',
        'pagamento recusado · R$ 150,00',
      ],
      [
        {
          ...base,
          type: 'OrderCancelled',
          orderId: 'o',
          reason: 'MOTIVO_NOVO',
          totalCents: 15_000,
        },
        'Pedido cancelado',
        'R$ 150,00',
      ],
      [
        { ...base, type: 'LotOpened', sectorName: 'Pista', lotName: '2º lote', priceCents: 18_000 },
        'Lote aberto',
        '2º lote em Pista · R$ 180,00',
      ],
      [
        { ...base, type: 'LotSoldOut', sectorName: 'Pista', lotName: '1º lote' },
        'Lote esgotado',
        '1º lote em Pista',
      ],
    ];
    for (const [entry, title, detail] of cases) {
      const text = describeActivity(entry);
      expect(text.title).toBe(title);
      expect(plain(text.detail)).toBe(detail);
    }
  });

  it('virada de lote sem setor e lote (lote chegou antes do show) fica neutra', () => {
    const opened = describeActivity({
      ...base,
      type: 'LotOpened',
      sectorName: null,
      lotName: null,
      priceCents: 18_000,
    });
    expect(plain(opened.detail)).toBe('Lote em um setor · R$ 180,00');
    const soldOut = describeActivity({
      ...base,
      type: 'LotSoldOut',
      sectorName: 'Pista',
      lotName: null,
    });
    expect(soldOut.detail).toBe('Lote em Pista');
  });

  it('monta uma frase só para o leitor de tela', () => {
    expect(plain(activitySentence(confirmedEntry(1)))).toBe(
      'Pedido confirmado: 2 ingressos em Pista, R$ 300,00.',
    );
  });
});

describe('relativeTime', () => {
  const at = '2026-11-26T18:00:00Z';
  const now = Date.parse(at);

  it('conta segundos, minutos e horas', () => {
    expect(relativeTime(at, now)).toBe('agora');
    expect(relativeTime(at, now + 4_999)).toBe('agora');
    expect(relativeTime(at, now + 12_000)).toBe('há 12 s');
    expect(relativeTime(at, now + 3 * 60_000 + 59_000)).toBe('há 3 min');
    expect(relativeTime(at, now + 2 * 3_600_000)).toBe('há 2 h');
  });

  it('relógio do navegador um pouco atrasado não dá tempo negativo', () => {
    expect(relativeTime(at, now - 3_000)).toBe('agora');
  });

  it('depois de um dia, mostra a data e a hora no fuso do show', () => {
    // 18h UTC são 15h em São Paulo e 14h em Manaus.
    expect(relativeTime(at, now + 2 * 86_400_000, 'America/Sao_Paulo')).toBe('26 de nov., 15:00');
    expect(relativeTime(at, now + 2 * 86_400_000, 'America/Manaus')).toBe('26 de nov., 14:00');
  });
});

describe('announcement', () => {
  it('anuncia uma entrada ou a contagem com a mais recente', () => {
    expect(announcement(0, confirmedEntry(1))).toBe('');
    expect(plain(announcement(1, confirmedEntry(1)))).toBe(
      'Pedido confirmado: 2 ingressos em Pista, R$ 300,00.',
    );
    expect(plain(announcement(3, confirmedEntry(1)))).toBe(
      '3 novas atividades. A mais recente: Pedido confirmado: 2 ingressos em Pista, R$ 300,00.',
    );
  });
});
