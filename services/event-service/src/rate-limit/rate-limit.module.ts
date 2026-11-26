import { Global, Module } from '@nestjs/common';
import { RateLimitGuard } from './rate-limit.guard.js';
import { SlidingWindowLimiter } from './sliding-window.limiter.js';

/** Global para que `@RateLimited()` funcione em qualquer controller. */
@Global()
@Module({
  providers: [SlidingWindowLimiter, RateLimitGuard],
  exports: [SlidingWindowLimiter, RateLimitGuard],
})
export class RateLimitModule {}
