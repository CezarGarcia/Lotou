import { Controller, Get } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  MongooseHealthIndicator,
} from '@nestjs/terminus';
import { Public } from '../auth/auth.decorators.js';

@Controller('health')
@Public()
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly mongoose: MongooseHealthIndicator,
  ) {}

  /** O processo está vivo? Não olha o banco: reiniciar não o consertaria. */
  @Get('live')
  @HealthCheck()
  live() {
    return this.health.check([]);
  }

  /** O serviço consegue atender agora? Falha se o MongoDB não responde. */
  @Get('ready')
  @HealthCheck()
  ready() {
    return this.health.check([
      () => this.mongoose.pingCheck('mongodb', { timeout: 1_000 }),
    ]);
  }
}
