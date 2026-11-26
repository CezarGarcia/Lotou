import { randomUUID } from 'node:crypto';
import { inject } from 'vitest';

// Cada arquivo de teste usa um banco só dele, então os arquivos rodam em
// paralelo sem um enxergar os dados do outro.
const url = new URL(inject('mongoUri'));
url.pathname = `/test_${randomUUID().replaceAll('-', '')}`;
url.searchParams.set('directConnection', 'true');
process.env.MONGODB_URI = url.toString();
