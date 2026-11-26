import { Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';

const OTEL_SDK = Symbol.for('lotou.otel.sdk');

/**
 * Encerra o SDK do OpenTelemetry quando a aplicação para, para que o último
 * lote de spans, métricas e logs seja enviado. O SDK é iniciado fora da
 * aplicação, em `instrumentation.ts`; sem ele (testes, por exemplo), não faz
 * nada.
 */
@Injectable()
class TelemetryShutdown implements OnApplicationShutdown {
  async onApplicationShutdown(): Promise<void> {
    const sdk = (globalThis as Record<symbol, unknown>)[OTEL_SDK] as
      { shutdown(): Promise<void> } | undefined;
    await sdk?.shutdown();
  }
}

@Module({ providers: [TelemetryShutdown] })
export class TelemetryModule {}
