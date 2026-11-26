import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { inject } from 'vitest';
import './quiet-logs.js';
import './tracing.js';

// Cada arquivo de teste usa um banco só dele: as migrações rodam do zero e um
// arquivo não enxerga os pagamentos do outro.
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
process.env.KAFKA_BROKERS = inject('kafkaBrokers');
