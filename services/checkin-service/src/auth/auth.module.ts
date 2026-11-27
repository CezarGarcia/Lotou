import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { createRemoteJWKSet } from 'jose';
import type { Env } from '../config/env.js';
import { AuthGuard } from './auth.guard.js';
import { JWT_KEY_SET, TokenVerifier } from './token-verifier.js';

@Module({
  providers: [
    {
      provide: JWT_KEY_SET,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        createRemoteJWKSet(
          new URL(config.get('AUTH_JWKS_URI', { infer: true })),
          { timeoutDuration: 3_000 },
        ),
    },
    TokenVerifier,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AuthModule {}
