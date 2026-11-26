import { parse } from 'pg-connection-string';
import { connectionString } from './connection-string.js';

describe('connectionString', () => {
  it('sem DATABASE_PASSWORD, usa a URL como veio', () => {
    const url = 'postgres://payments:segredo@postgres:5432/payments';
    expect(connectionString(url)).toBe(url);
  });

  it('põe a senha separada na URL, que é o que o driver lê', () => {
    const result = connectionString(
      'postgres://payments@postgres:5432/payments',
      'segredo',
    );
    expect(parse(result)).toMatchObject({
      user: 'payments',
      password: 'segredo',
      host: 'postgres',
      port: '5432',
      database: 'payments',
    });
  });

  it('a senha separada vale por cima da que está na URL', () => {
    const result = connectionString(
      'postgres://payments:velha@postgres:5432/payments',
      'nova',
    );
    expect(parse(result).password).toBe('nova');
  });

  it('aceita senha com caracteres especiais', () => {
    const password = 'p@ss:w/rd#1%';
    const result = connectionString(
      'postgresql://payments@postgres/payments',
      password,
    );
    expect(parse(result).password).toBe(password);
  });
});
