import { newId } from '../common/ids/id.js';
import type { VenueSector } from '../venues/venue.schema.js';
import {
  buildSectors,
  localDate,
  publishViolations,
  scheduleViolations,
} from './show-rules.js';

const pista: VenueSector = {
  id: newId(),
  name: 'Pista',
  kind: 'GENERAL_ADMISSION',
  capacity: 2000,
};
const cadeira: VenueSector = {
  id: newId(),
  name: 'Cadeira inferior',
  kind: 'RESERVED_SEATING',
  capacity: 500,
};
const venue = { sectors: [pista, cadeira] };

const lot = (quantity: number, name = `Lote ${quantity}`) => ({
  name,
  priceCents: 12_000,
  quantity,
});

describe('buildSectors', () => {
  it('copia nome e tipo do local e assume a capacidade dele por padrão', () => {
    const { sectors, violations } = buildSectors(
      [{ sectorId: pista.id, lots: [lot(1500)] }],
      venue,
    );

    expect(violations).toEqual([]);
    expect(sectors).toEqual([
      {
        id: pista.id,
        name: 'Pista',
        kind: 'GENERAL_ADMISSION',
        capacity: 2000,
        lots: [
          {
            id: expect.any(String),
            name: 'Lote 1500',
            priceCents: 12_000,
            quantity: 1500,
            opensAt: null,
          },
        ],
      },
    ]);
  });

  it('aceita a soma dos lotes igual à capacidade do setor', () => {
    const { violations } = buildSectors(
      [{ sectorId: pista.id, lots: [lot(1200), lot(800)] }],
      venue,
    );
    expect(violations).toEqual([]);
  });

  it('recusa a soma dos lotes acima da capacidade do setor', () => {
    const { violations } = buildSectors(
      [{ sectorId: pista.id, capacity: 1000, lots: [lot(600), lot(401)] }],
      venue,
    );
    expect(violations).toEqual([
      {
        field: 'sectors.0.lots',
        message: 'A soma dos lotes (1001) passa da capacidade do setor (1000)',
      },
    ]);
  });

  it('recusa capacidade acima da capacidade do setor no local', () => {
    const { violations } = buildSectors(
      [{ sectorId: cadeira.id, capacity: 501, lots: [] }],
      venue,
    );
    expect(violations.map((v) => v.field)).toEqual(['sectors.0.capacity']);
  });

  it('recusa setor que não existe no local e setor repetido', () => {
    const { violations } = buildSectors(
      [
        { sectorId: newId(), lots: [] },
        { sectorId: pista.id, lots: [] },
        { sectorId: pista.id, lots: [] },
      ],
      venue,
    );
    expect(violations.map((v) => v.field)).toEqual([
      'sectors.0.sectorId',
      'sectors.2.sectorId',
    ]);
  });

  it('recusa setores sem local definido', () => {
    const { violations } = buildSectors(
      [{ sectorId: pista.id, lots: [] }],
      null,
    );
    expect(violations.map((v) => v.field)).toEqual(['venueId']);
  });

  it('recusa lotes com o mesmo nome no setor', () => {
    const { violations } = buildSectors(
      [{ sectorId: pista.id, lots: [lot(10, 'Lote 1'), lot(20, 'lote 1')] }],
      venue,
    );
    expect(violations.map((v) => v.field)).toEqual(['sectors.0.lots']);
  });

  it('mantém o ID de um lote existente e gera ID para lote novo', () => {
    const first = buildSectors(
      [{ sectorId: pista.id, lots: [lot(100, 'Lote 1')] }],
      venue,
    ).sectors;
    const existingId = first[0].lots[0].id;

    const { sectors, violations } = buildSectors(
      [
        {
          sectorId: pista.id,
          lots: [{ ...lot(150, 'Lote 1'), id: existingId }, lot(200, 'Lote 2')],
        },
      ],
      venue,
      first,
    );

    expect(violations).toEqual([]);
    expect(sectors[0].lots[0].id).toBe(existingId);
    expect(sectors[0].lots[1].id).not.toBe(existingId);
  });

  it('recusa ID de lote que não pertence ao setor', () => {
    const { violations } = buildSectors(
      [{ sectorId: pista.id, lots: [{ ...lot(10), id: newId() }] }],
      venue,
    );
    expect(violations.map((v) => v.field)).toEqual(['sectors.0.lots.0.id']);
  });
});

describe('scheduleViolations', () => {
  const startsAt = new Date('2027-03-20T23:00:00Z');
  const base = {
    startsAt,
    doorsOpenAt: new Date('2027-03-20T21:00:00Z'),
    salesStartAt: new Date('2027-01-10T13:00:00Z'),
    salesEndAt: new Date('2027-03-20T20:00:00Z'),
  };

  it('aceita vendas, portões e show na ordem certa', () => {
    expect(scheduleViolations(base)).toEqual([]);
    expect(
      scheduleViolations({
        startsAt,
        doorsOpenAt: null,
        salesStartAt: null,
        salesEndAt: null,
      }),
    ).toEqual([]);
  });

  it('recusa portões abrindo depois do início do show', () => {
    const violations = scheduleViolations({
      ...base,
      doorsOpenAt: new Date('2027-03-20T23:30:00Z'),
    });
    expect(violations.map((v) => v.field)).toEqual(['doorsOpenAt']);
  });

  it('recusa vendas abrindo depois do show ou encerrando antes de abrir', () => {
    expect(
      scheduleViolations({ ...base, salesStartAt: startsAt }).map(
        (v) => v.field,
      ),
    ).toContain('salesStartAt');
    expect(
      scheduleViolations({ ...base, salesEndAt: base.salesStartAt }).map(
        (v) => v.field,
      ),
    ).toEqual(['salesEndAt']);
  });
});

describe('publishViolations', () => {
  const now = new Date('2027-01-01T00:00:00Z');
  const ready = {
    venue: {
      id: newId(),
      name: 'Arena',
      city: 'São Paulo',
      state: 'SP',
      timezone: 'America/Sao_Paulo',
      citySearch: 'sao paulo',
    },
    sectors: buildSectors([{ sectorId: pista.id, lots: [lot(100)] }], venue)
      .sectors,
    startsAt: new Date('2027-03-20T23:00:00Z'),
  };

  it('aceita show com local, setor e lote', () => {
    expect(publishViolations(ready, now)).toEqual([]);
  });

  it('exige local, ao menos um setor e ao menos um lote', () => {
    expect(
      publishViolations({ ...ready, venue: null, sectors: [] }, now).map(
        (v) => v.field,
      ),
    ).toEqual(['venueId', 'sectors']);

    const withoutLots = buildSectors(
      [{ sectorId: pista.id, lots: [] }],
      venue,
    ).sectors;
    expect(publishViolations({ ...ready, sectors: withoutLots }, now)).toEqual([
      { field: 'sectors', message: 'Configure ao menos um lote' },
    ]);
  });

  it('recusa show com data no passado', () => {
    expect(
      publishViolations(ready, new Date('2027-03-21T00:00:00Z')).map(
        (v) => v.field,
      ),
    ).toEqual(['startsAt']);
  });
});

describe('localDate', () => {
  it('usa o dia no fuso do local, não em UTC', () => {
    // 22h de 31/12 em São Paulo já é 01h de 1º/01 em UTC.
    const instant = new Date('2027-01-01T01:00:00Z');
    expect(localDate(instant, 'America/Sao_Paulo')).toBe('2026-12-31');
    expect(localDate(instant, 'UTC')).toBe('2027-01-01');
    expect(localDate(instant, 'America/Manaus')).toBe('2026-12-31');
  });
});
