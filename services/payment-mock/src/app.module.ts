import './config/zod-locale.js';

import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { type Env, envSchema } from './config/env.js';
import { ConsumerModule } from './consumer/consumer.module.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthModule } from './health/health.module.js';
import { KafkaModule } from './kafka/kafka.module.js';
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
          // A única rota é o health check; não há o que registrar por requisição.
          autoLogging: false,
        },
      }),
    }),
    DatabaseModule,
    KafkaModule,
    HealthModule,
    ConsumerModule,
  ],
})
export class AppModule {}
