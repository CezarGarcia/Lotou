import { type RetryPolicy, retryDelayMs } from './retry-policy.js';

describe('retryDelayMs', () => {
  const policy: RetryPolicy = {
    maxAttempts: 5,
    initialBackoffMs: 200,
    maxBackoffMs: 5_000,
    transientBudgetMs: 60_000,
  };

  it('dobra a espera a cada tentativa, até o teto', () => {
    const delays = [1, 2, 3, 4, 5, 6, 7].map((attempt) =>
      retryDelayMs(attempt, policy),
    );
    expect(delays).toEqual([200, 400, 800, 1_600, 3_200, 5_000, 5_000]);
  });

  it('com backoff zero, tenta de novo na hora', () => {
    expect(retryDelayMs(3, { ...policy, initialBackoffMs: 0 })).toBe(0);
  });
});
