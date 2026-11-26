import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import type { Env } from './config/env.js';

// Os logs da subida ficam em buffer até o logger JSON estar pronto.
const app = await NestFactory.create(AppModule, { bufferLogs: true });
app.useLogger(app.get(Logger));
// SIGTERM do Docker: para o consumidor, publica o último lote do outbox e
// fecha as conexões antes de sair.
app.enableShutdownHooks();

const config = app.get<ConfigService<Env, true>>(ConfigService);
await app.listen(config.get('PORT', { infer: true }));
