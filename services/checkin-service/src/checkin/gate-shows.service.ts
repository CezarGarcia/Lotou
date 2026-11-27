import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Pool } from 'pg';
import type { AuthenticatedUser } from '../auth/authenticated-user.js';
import { Problems } from '../common/problem/problem.js';
import type { Env } from '../config/env.js';
import { PG_POOL } from '../database/database.module.js';
import {
  type CursorPosition,
  type Page,
  toPage,
} from '../common/pagination/cursor.js';

export interface GateShowResponse {
  showId: string;
  title: string;
  artist: string;
  startsAt: string;
  timezone: string;
  doorsOpenAt: string | null;
  venueName: string;
}

export interface SummaryResponse {
  checkedIn: number;
  byGate: { gate: string; count: number }[];
  rejected: number;
}

interface ShowRow {
  show_id: string;
  title: string;
  artist: string;
  starts_at: Date;
  timezone: string;
  doors_open_at: Date | null;
  venue_name: string;
}

/**
 * Até quantas horas depois do início um show continua na lista: um show que
 * começou às 23h ainda está com a portaria aberta depois da meia-noite.
 */
const STILL_RUNNING_HOURS = 12;

/** O que a portaria consulta além da leitura: a lista de shows e o resumo. */
@Injectable()
export class GateShowsService {
  private readonly daysAhead: number;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    config: ConfigService<Env, true>,
  ) {
    this.daysAhead = config.get('SHOWS_DAYS_AHEAD', { infer: true });
  }

  /**
   * Shows de hoje e dos próximos dias, da cópia local do catálogo, em ordem de
   * início. "Hoje" é o dia no fuso de cada show: às 22h de São Paulo já é
   * amanhã em UTC, e o show de hoje continua na lista.
   */
  async list(
    cursor: CursorPosition | undefined,
    limit: number,
  ): Promise<Page<GateShowResponse>> {
    const { rows } = await this.pool.query<ShowRow>(
      `SELECT show_id, title, artist, starts_at, timezone, doors_open_at, venue_name
         FROM shows
        WHERE status <> 'CANCELLED'
          AND starts_at >= LEAST(
                date_trunc('day', now() AT TIME ZONE timezone) AT TIME ZONE timezone,
                now() - make_interval(hours => $1))
          AND starts_at < now() + make_interval(days => $2)
          AND ($3::timestamptz IS NULL
               OR (starts_at, show_id) > ($3::timestamptz, $4::uuid))
        ORDER BY starts_at, show_id
        LIMIT $5`,
      [
        STILL_RUNNING_HOURS,
        this.daysAhead + 1,
        cursor ? new Date(cursor.sortValue) : null,
        cursor?.id ?? null,
        limit + 1,
      ],
    );
    return toPage(
      rows,
      limit,
      (row) => ({ sortValue: row.starts_at.getTime(), id: row.show_id }),
      (row) => ({
        showId: row.show_id,
        title: row.title,
        artist: row.artist,
        startsAt: row.starts_at.toISOString(),
        timezone: row.timezone,
        doorsOpenAt: row.doors_open_at?.toISOString() ?? null,
        venueName: row.venue_name,
      }),
    );
  }

  /**
   * Entradas por portão e leituras recusadas do show. A portaria vê qualquer
   * show; o produtor, só os dele. Para os outros, o show "não existe": a
   * resposta não diz se ele existe.
   */
  async summary(
    showId: string,
    user: AuthenticatedUser,
  ): Promise<SummaryResponse> {
    const {
      rows: [show],
    } = await this.pool.query<{ producer_id: string }>(
      'SELECT producer_id FROM shows WHERE show_id = $1',
      [showId],
    );
    const isGateStaff = user.roles.includes('gate-staff');
    if (!show || (!isGateStaff && show.producer_id !== user.id)) {
      throw Problems.notFound('Show');
    }

    const [byGate, rejected] = await Promise.all([
      this.pool.query<{ gate: string; count: number }>(
        `SELECT gate, count(*)::int AS count
           FROM checkins
          WHERE show_id = $1
          GROUP BY gate
          ORDER BY gate`,
        [showId],
      ),
      this.pool.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM checkin_rejections WHERE show_id = $1',
        [showId],
      ),
    ]);
    return {
      checkedIn: byGate.rows.reduce((total, row) => total + row.count, 0),
      byGate: byGate.rows,
      rejected: rejected.rows[0].count,
    };
  }
}
