import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  IdempotencyRecord,
  IdempotencyRecordSchema,
} from './idempotency-record.schema.js';
import { IdempotencyInterceptor } from './idempotency.interceptor.js';
import { IdempotencyStore } from './idempotency.store.js';

@Global()
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: IdempotencyRecord.name, schema: IdempotencyRecordSchema },
    ]),
  ],
  providers: [IdempotencyStore, IdempotencyInterceptor],
  exports: [IdempotencyStore, IdempotencyInterceptor],
})
export class IdempotencyModule {}
