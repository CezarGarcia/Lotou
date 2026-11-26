import { createTestIssuer } from './support/auth.js';
import { createTestApp, type TestApp } from './support/app.js';
import { arena } from './support/fixtures.js';

describe('Autenticação e autorização', () => {
  let t: TestApp;
  const withToken = (token: string) =>
    t.anonymous
      .post('/v1/venues', arena)
      .set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  it('responde 401 em Problem Details quando falta o token', async () => {
    const response = await t.anonymous.post('/v1/venues', arena).expect(401);

    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(response.headers['www-authenticate']).toBe('Bearer');
    expect(response.body).toMatchObject({
      type: 'urn:lotou:problem:unauthorized',
      title: 'Não autenticado',
      status: 401,
      instance: '/v1/venues',
    });
  });

  it('responde 403 quando o usuário não tem o papel exigido', async () => {
    const buyer = await t.as('buyer');
    const response = await buyer.post('/v1/venues', arena).expect(403);
    expect(response.body.type).toBe('urn:lotou:problem:forbidden');
  });

  it('aceita o token de um produtor', async () => {
    const producer = await t.as('producer');
    await producer.post('/v1/venues', arena).expect(201);
  });

  it('recusa token expirado', async () => {
    const token = await t.issuer.token({
      roles: ['producer'],
      expiresIn: -60,
    });
    const response = await withToken(token).expect(401);
    expect(response.body.detail).toBe('O token expirou.');
  });

  it('recusa token de outro emissor, de outra audiência ou de outra chave', async () => {
    const otherIssuer = await createTestIssuer();
    const tokens = [
      await t.issuer.token({
        roles: ['producer'],
        issuer: 'http://outro-emissor.test/realms/lotou',
      }),
      await t.issuer.token({ roles: ['producer'], audience: 'outra-api' }),
      await otherIssuer.token({ roles: ['producer'] }),
      'isto-não-é-um-jwt',
    ];

    for (const token of tokens) {
      const response = await withToken(token).expect(401);
      expect(response.body.detail).toBe('O token é inválido.');
    }
  });

  it('recusa esquema de autorização diferente de Bearer', async () => {
    await t.anonymous
      .post('/v1/venues', arena)
      .set('Authorization', 'Basic dXNlcjpwYXNz')
      .expect(401);
  });

  it('valida o token mesmo em rota pública', async () => {
    const expired = await t.issuer.token({ expiresIn: -60 });
    await t.anonymous
      .get('/v1/shows')
      .set('Authorization', `Bearer ${expired}`)
      .expect(401);
    await t.anonymous.get('/v1/shows').expect(200);
  });

  it('deixa o health check aberto e sem versão na URL', async () => {
    const live = await t.anonymous.get('/health/live').expect(200);
    expect(live.body.status).toBe('ok');

    const ready = await t.anonymous.get('/health/ready').expect(200);
    expect(ready.body.info.mongodb.status).toBe('up');
  });

  it('responde 404 em Problem Details para rota inexistente', async () => {
    const response = await t.anonymous.get('/v1/nada').expect(404);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(response.body).toMatchObject({ type: 'about:blank', status: 404 });
  });
});
