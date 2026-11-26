import { rateLimitSubject } from './rate-limit.guard.js';

describe('rateLimitSubject', () => {
  it('usa o usuário do token quando há um', () => {
    expect(rateLimitSubject('usuario-1', '203.0.113.7')).toBe('usuario-1');
  });

  it('sem token, usa o hash do IP, nunca o IP', () => {
    const subject = rateLimitSubject(undefined, '203.0.113.7');
    expect(subject).toMatch(/^ip:[0-9a-f]{64}$/);
    expect(subject).not.toContain('203.0.113.7');
    expect(rateLimitSubject(undefined, '203.0.113.7')).toBe(subject);
    expect(rateLimitSubject(undefined, '203.0.113.8')).not.toBe(subject);
  });
});
