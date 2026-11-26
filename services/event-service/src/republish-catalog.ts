/**
 * Republica no Kafka o snapshot atual de todo show publicado:
 * `npm run catalog:republish` (no container: `docker compose exec
 * event-service npm run catalog:republish`).
 *
 * Só grava no outbox; quem publica é o relay do serviço no ar. Lê apenas a
 * `MONGODB_URI`.
 */
import 'reflect-metadata';

import mongoose from 'mongoose';
import { envSchema } from './config/env.js';
import { OutboxMessage, OutboxMessageSchema } from './outbox/outbox.schema.js';
import { republishCatalog } from './shows/catalog-republish.js';
import { Show, ShowSchema } from './shows/show.schema.js';

const { MONGODB_URI } = envSchema
  .pick({ MONGODB_URI: true })
  .parse(process.env);

await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 5_000 });
try {
  const count = await republishCatalog(
    mongoose.model(Show.name, ShowSchema),
    mongoose.model(OutboxMessage.name, OutboxMessageSchema),
  );
  console.log(
    `${count} show(s) no outbox; o relay do event-service publica em shows.catalog.`,
  );
} finally {
  await mongoose.disconnect();
}
