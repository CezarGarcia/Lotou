import { newId } from '../common/ids/id.js';
import type { ProblemViolation } from '../common/problem/problem.js';
import type { Venue } from '../venues/venue.schema.js';
import type { Show, ShowSector } from './show.schema.js';

/**
 * Regras de negócio do show (seção "Show e capacidade" de docs/projeto.md).
 * Funções puras: recebem o estado e devolvem as violações, sem tocar no banco.
 */

export interface LotInput {
  id?: string;
  name: string;
  priceCents: number;
  quantity: number;
  opensAt?: Date | null;
}

export interface SectorInput {
  sectorId: string;
  capacity?: number;
  lots: LotInput[];
}

export interface Schedule {
  startsAt: Date;
  doorsOpenAt: Date | null;
  salesStartAt: Date | null;
  salesEndAt: Date | null;
}

/**
 * Monta os setores do show a partir do que o produtor enviou e do local.
 *
 * - A capacidade pertence ao setor, e nunca passa da capacidade do local.
 * - O lote só define preço e quantidade dentro do setor: a soma dos lotes
 *   nunca passa da capacidade do setor.
 * - Um lote enviado com `id` mantém a identidade do lote existente.
 */
export function buildSectors(
  inputs: SectorInput[],
  venue: Pick<Venue, 'sectors'> | null,
  current: ShowSector[] = [],
): { sectors: ShowSector[]; violations: ProblemViolation[] } {
  const violations: ProblemViolation[] = [];
  if (inputs.length > 0 && !venue) {
    return {
      sectors: [],
      violations: [
        { field: 'venueId', message: 'Defina o local antes dos setores' },
      ],
    };
  }

  const seen = new Set<string>();
  const sectors: ShowSector[] = [];

  inputs.forEach((input, index) => {
    const path = `sectors.${index}`;
    const venueSector = venue?.sectors.find((s) => s.id === input.sectorId);
    if (!venueSector) {
      violations.push({
        field: `${path}.sectorId`,
        message: 'Este setor não existe no local do show',
      });
      return;
    }
    if (seen.has(input.sectorId)) {
      violations.push({
        field: `${path}.sectorId`,
        message: 'O mesmo setor aparece mais de uma vez',
      });
      return;
    }
    seen.add(input.sectorId);

    const capacity = input.capacity ?? venueSector.capacity;
    if (capacity > venueSector.capacity) {
      violations.push({
        field: `${path}.capacity`,
        message: `A capacidade (${capacity}) passa da capacidade do setor no local (${venueSector.capacity})`,
      });
    } else if (
      venueSector.kind === 'RESERVED_SEATING' &&
      capacity !== venueSector.capacity
    ) {
      // Cada cadeira é um item único: o show vende todas as cadeiras do setor.
      violations.push({
        field: `${path}.capacity`,
        message: `Num setor de cadeira numerada a capacidade é a do local (${venueSector.capacity})`,
      });
    }

    const onSale = input.lots.reduce((sum, lot) => sum + lot.quantity, 0);
    if (onSale > capacity) {
      violations.push({
        field: `${path}.lots`,
        message: `A soma dos lotes (${onSale}) passa da capacidade do setor (${capacity})`,
      });
    }

    const lotNames = new Set(input.lots.map((lot) => lot.name.toLowerCase()));
    if (lotNames.size !== input.lots.length) {
      violations.push({
        field: `${path}.lots`,
        message: 'Os lotes de um setor precisam ter nomes diferentes',
      });
    }

    const currentLotIds = new Set(
      current.find((s) => s.id === input.sectorId)?.lots.map((lot) => lot.id),
    );
    const usedLotIds = new Set<string>();
    const lots = input.lots.map((lot, lotIndex) => {
      if (lot.id !== undefined) {
        if (!currentLotIds.has(lot.id) || usedLotIds.has(lot.id)) {
          violations.push({
            field: `${path}.lots.${lotIndex}.id`,
            message: 'Este lote não existe neste setor',
          });
        }
        usedLotIds.add(lot.id);
      }
      return {
        id: lot.id ?? newId(),
        name: lot.name,
        priceCents: lot.priceCents,
        quantity: lot.quantity,
        opensAt: lot.opensAt ?? null,
      };
    });

    sectors.push({
      id: venueSector.id,
      name: venueSector.name,
      kind: venueSector.kind,
      capacity,
      rows: (venueSector.rows ?? []).map(({ label, seatCount }) => ({
        label,
        seatCount,
      })),
      lots,
    });
  });

  return { sectors, violations };
}

/** A ordem das datas: vendas abrem, vendas fecham, portões abrem, show começa. */
export function scheduleViolations({
  startsAt,
  doorsOpenAt,
  salesStartAt,
  salesEndAt,
}: Schedule): ProblemViolation[] {
  const violations: ProblemViolation[] = [];
  if (doorsOpenAt && doorsOpenAt > startsAt) {
    violations.push({
      field: 'doorsOpenAt',
      message: 'Os portões precisam abrir antes do início do show',
    });
  }
  if (salesStartAt && salesStartAt >= startsAt) {
    violations.push({
      field: 'salesStartAt',
      message: 'As vendas precisam abrir antes do início do show',
    });
  }
  if (salesEndAt && salesEndAt > startsAt) {
    violations.push({
      field: 'salesEndAt',
      message: 'As vendas precisam encerrar até o início do show',
    });
  }
  if (salesStartAt && salesEndAt && salesEndAt <= salesStartAt) {
    violations.push({
      field: 'salesEndAt',
      message: 'O encerramento das vendas precisa ser depois da abertura',
    });
  }
  return violations;
}

/**
 * O que falta para o show poder ser publicado: local, ao menos um setor e ao
 * menos um lote, numa data que ainda não passou.
 */
export function publishViolations(
  show: Pick<Show, 'venue' | 'sectors' | 'startsAt'>,
  now: Date = new Date(),
): ProblemViolation[] {
  const violations: ProblemViolation[] = [];
  if (!show.venue) {
    violations.push({ field: 'venueId', message: 'Defina o local do show' });
  }
  if (show.sectors.length === 0) {
    violations.push({
      field: 'sectors',
      message: 'Configure ao menos um setor',
    });
  } else if (show.sectors.every((sector) => sector.lots.length === 0)) {
    violations.push({
      field: 'sectors',
      message: 'Configure ao menos um lote',
    });
  }
  if (show.startsAt <= now) {
    violations.push({
      field: 'startsAt',
      message: 'A data do show já passou',
    });
  }
  return violations;
}

/** O dia `AAAA-MM-DD` de um instante, no fuso informado. */
export function localDate(instant: Date, timezone: string): string {
  // O locale en-CA formata datas como AAAA-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}
