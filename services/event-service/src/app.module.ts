import './config/zod-locale.js';

import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { MongooseModule } from '@nestjs/mongoose';
import { LoggerModule } from 'nestjs-pino';
import { AuthModule } from './auth/auth.module.js';
import { IdempotencyModule } from './common/idempotency/idempotency.module.js';
import { ProblemDetailsFilter } from './common/problem/problem-details.filter.js';
import { createValidationPipe } from './common/problem/validation.js';
import { type Env, envSchema } from './config/env.js';
import { HealthModule } from './health/health.module.js';
import { RateLimitModule } from './rate-limit/rate-limit.module.js';
import { RedisModule } from './redis/redis.module.js';
import { ShowsModule } from './shows/shows.module.js';
import { TelemetryModule } from './telemetry/telemetry.module.js';
import { VenuesModule } from './venues/venues.module.js';

@Module({
  imports: [
    // Primeiro, para encerrar por último e enviar o que os outros registraram.
    TelemetryModule,
    ConfigModule.forRoot({ isGlobal: true, validationSchema: envSchema }),
    // Logs em JSON, uma linha por evento. A instrumentação do pino acrescenta
    // trace_id e span_id e envia os logs por OTLP.
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        pinoHttp: {
          level: config.get('LOG_LEVEL', { infer: true }),
          // Nada de cabeçalhos, IP ou corpo no log: só o que identifica a rota.
          serializers: {
            req: (req: { method: string; url: string }) => ({
              method: req.method,
              url: req.url.split('?')[0],
            }),
            res: (res: { statusCode: number }) => ({
              statusCode: res.statusCode,
            }),
          },
          autoLogging: {
            ignore: (req) => req.url?.startsWith('/health') ?? false,
          },
        },
      }),
    }),
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        uri: config.get('MONGODB_URI', { infer: true }),
        // Quanto uma operação espera por um servidor antes de falhar.
        serverSelectionTimeoutMS: 5_000,
        // Cada model espera a coleção e os índices antes de ser injetado.
        waitForModelInit: true,
      }),
    }),
    RedisModule,
    AuthModule,
    RateLimitModule,
    IdempotencyModule,
    HealthModule,
    VenuesModule,
    ShowsModule,
  ],
  providers: [
    // Providers do módulo, e não chamadas no main.ts: os testes sobem o
    // AppModule sem o main.ts e recebem o mesmo pipe e o mesmo filtro.
    { provide: APP_PIPE, useFactory: createValidationPipe },
    { provide: APP_FILTER, useClass: ProblemDetailsFilter },
  ],
})
export class AppModule {}
