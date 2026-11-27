import './config/zod-locale.js';

import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { AuthModule } from './auth/auth.module.js';
import { CheckinModule } from './checkin/checkin.module.js';
import { ProblemDetailsFilter } from './common/problem/problem-details.filter.js';
import { createValidationPipe } from './common/problem/validation.js';
import { type Env, envSchema } from './config/env.js';
import { ConsumerModule } from './consumer/consumer.module.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthModule } from './health/health.module.js';
import { KafkaModule } from './kafka/kafka.module.js';
import { RedisModule } from './redis/redis.module.js';
import { TelemetryModule } from './telemetry/telemetry.module.js';

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
          // Nada de cabeçalhos, IP ou corpo no log: o corpo da leitura traz o
          // QR code, que é o próprio ingresso.
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
    DatabaseModule,
    RedisModule,
    KafkaModule,
    AuthModule,
    HealthModule,
    CheckinModule,
    ConsumerModule,
  ],
  providers: [
    // Providers do módulo, e não chamadas no main.ts: os testes sobem o
    // AppModule sem o main.ts e recebem o mesmo pipe e o mesmo filtro.
    { provide: APP_PIPE, useFactory: createValidationPipe },
    { provide: APP_FILTER, useClass: ProblemDetailsFilter },
  ],
})
export class AppModule {}
