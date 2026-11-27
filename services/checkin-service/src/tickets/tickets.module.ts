import { Module } from '@nestjs/common';
import { LocalCopyService } from './local-copy.service.js';

@Module({
  providers: [LocalCopyService],
  exports: [LocalCopyService],
})
export class TicketsModule {}
