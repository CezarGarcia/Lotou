import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { inject } from 'vitest';

// Cada arquivo de teste usa um banco só dele, então os arquivos rodam em
// paralelo sem um enxergar os dados do outro.
const url = new URL(inject('mongoUri'));
url.pathname = `/test_${randomUUID().replaceAll('-', '')}`;
url.searchParams.set('directConnection', 'true');
process.env.MONGODB_URI = url.toString();

// No Redis, o mesmo isolamento com bancos lógicos: dois por arquivo, um para
// cada instância (`redis-cache` e `redis-core`). O contador no banco 0 dá a
// cada arquivo um par que nenhum outro usa.
const redisUrl = (db: number) => {
  const redis = new URL(inject('redisUrl'));
  redis.pathname = `/${db}`;
  return redis.toString();
};
const allocator = new Redis(redisUrl(0));
const last = await allocator.incrby('test:databases', 2);
await allocator.quit();
process.env.REDIS_CACHE_URL = redisUrl(last - 1);
process.env.REDIS_CORE_URL = redisUrl(last);
