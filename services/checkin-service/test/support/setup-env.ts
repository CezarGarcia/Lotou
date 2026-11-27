import { Redis } from 'ioredis';
import pg from 'pg';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { inject } from 'vitest';
import './quiet-logs.js';
import './tracing.js';

// Cada arquivo de teste usa um banco só dele: as migrações rodam do zero e um
// arquivo não enxerga os ingressos do outro.
const admin = new pg.Client({ connectionString: inject('postgresUrl') });
const database = `test_${randomUUID().replaceAll('-', '')}`;
await admin.connect();
await admin.query(`CREATE DATABASE ${database}`);
await admin.end();

// A senha vai à parte, como no Compose (`DATABASE_PASSWORD`).
const url = new URL(inject('postgresUrl'));
url.pathname = `/${database}`;
process.env.DATABASE_PASSWORD = decodeURIComponent(url.password);
url.password = '';
process.env.DATABASE_URL = url.toString();

// No Redis, o mesmo isolamento com bancos lógicos: o contador no banco 0 dá a
// cada arquivo um banco que nenhum outro usa.
const redisUrl = (db: number) => {
  const redis = new URL(inject('redisUrl'));
  redis.pathname = `/${db}`;
  return redis.toString();
};
const allocator = new Redis(redisUrl(0));
const db = await allocator.incr('test:databases');
await allocator.quit();
process.env.REDIS_URL = redisUrl(db);

process.env.KAFKA_BROKERS = inject('kafkaBrokers');

// O par de chaves do QR `LOTOU2`, gerado na hora: a aplicação recebe a pública,
// como no Compose, e as fixtures assinam os ingressos com a privada.
const ticketKeys = generateKeyPairSync('ed25519');
process.env.TICKET_PUBLIC_KEY = ticketKeys.publicKey
  .export({ format: 'der', type: 'spki' })
  .toString('base64');
process.env.TEST_TICKET_PRIVATE_KEY = ticketKeys.privateKey
  .export({ format: 'der', type: 'pkcs8' })
  .toString('base64');
