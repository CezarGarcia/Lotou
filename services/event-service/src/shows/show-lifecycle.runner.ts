import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import { ShowsService } from './shows.service.js';

/**
 * Job de abertura e encerramento das vendas: de tempos em tempos, avança os
 * shows cujo horário chegou. Não precisa de lock distribuído, porque cada
 * avanço é um update condicional no banco.
 */
@Injectable()
export class ShowLifecycleRunner
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(ShowLifecycleRunner.name);
  private readonly intervalMs: number;
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly shows: ShowsService,
    config: ConfigService<Env, true>,
  ) {
    this.intervalMs = config.get('SHOW_LIFECYCLE_INTERVAL_MS', { infer: true });
  }

  onApplicationBootstrap(): void {
    if (this.intervalMs > 0) {
      this.timer = setInterval(() => void this.tick(), this.intervalMs);
    }
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    // Uma execução lenta não se sobrepõe à seguinte.
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      await this.shows.advanceLifecycle();
    } catch (error) {
      this.logger.error(
        'Falha ao avançar o estado dos shows',
        error instanceof Error ? error.stack : undefined,
      );
    } finally {
      this.running = false;
    }
  }
}
