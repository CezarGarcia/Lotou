import { defineConfig } from 'vitest/config';

// Testes unitários: regras de domínio, sem banco. Ficam ao lado do código.
export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['src/**/*.spec.ts'],
  },
});
