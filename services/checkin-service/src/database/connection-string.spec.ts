import { parse } from 'pg-connection-string';
import { connectionString } from './connection-string.js';

describe('connectionString', () => {
  it('sem DATABASE_PASSWORD, usa a URL como veio', () => {
    const url = 'postgres://checkin:segredo@postgres:5432/checkin';
    expect(connectionString(url)).toBe(url);
  });

  it('põe a senha separada na URL, que é o que o driver lê', () => {
    const result = connectionString(
      'postgres://checkin@postgres:5432/checkin',
      'segredo',
    );
    expect(parse(result)).toMatchObject({
      user: 'checkin',
      password: 'segredo',
      host: 'postgres',
      port: '5432',
      database: 'checkin',
    });
  });

  it('a senha separada vale por cima da que está na URL', () => {
    const result = connectionString(
      'postgres://checkin:velha@postgres:5432/checkin',
      'nova',
    );
    expect(parse(result).password).toBe('nova');
  });

  it('aceita senha com caracteres especiais', () => {
    const password = 'p@ss:w/rd#1%';
    const result = connectionString(
      'postgresql://checkin@postgres/checkin',
      password,
    );
    expect(parse(result).password).toBe(password);
  });
});
