import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CacheMetrics } from '../../cache/cache-metrics.js';
import { Show, ShowSchema } from '../show.schema.js';
import { ShowPageCache } from './show-page.cache.js';
import { ShowSearchCache } from './show-search.cache.js';

/**
 * Cache da página e da busca de shows. Módulo à parte porque os locais também
 * tiram shows do cache (a página mostra nome e endereço do local), e o
 * `VenuesModule` não pode importar o `ShowsModule`, que já o importa.
 */
@Module({
  imports: [
    MongooseModule.forFeature([{ name: Show.name, schema: ShowSchema }]),
  ],
  providers: [CacheMetrics, ShowPageCache, ShowSearchCache],
  exports: [ShowPageCache, ShowSearchCache],
})
export class ShowCacheModule {}
