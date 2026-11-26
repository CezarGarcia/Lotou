import { redactAuthParams } from './telemetry';

describe('redactAuthParams', () => {
  it('esconde o código e o state que o Keycloak devolve na volta do login', () => {
    const url = redactAuthParams(
      'http://localhost:4200/?state=abc&session_state=s1&iss=http%3A%2F%2Fkc&code=segredo',
    );
    expect(url).not.toContain('segredo');
    expect(url).not.toContain('abc');
    expect(new URL(url).searchParams.get('code')).toBe('REDACTED');
  });

  it('não mexe nas outras URLs', () => {
    expect(redactAuthParams('http://localhost:4200/?city=Recife')).toBe(
      'http://localhost:4200/?city=Recife',
    );
    expect(redactAuthParams('não é URL')).toBe('não é URL');
  });
});
