"""Coleções de uma geração dos read models.

Cada geração tem as suas coleções, com o número no nome (`order_view_g3`). O
replay monta a geração seguinte ao lado da ativa e troca o ponteiro no fim
(veja `analytics.store.generations`). Para quem lê o banco de fora (o
producer-assistant, o mongosh), uma view com o nome sem sufixo (`order_view`)
aponta sempre para a geração ativa.
"""

from contextlib import suppress
from dataclasses import dataclass
from datetime import timedelta
from typing import Any

from pymongo import ASCENDING, DESCENDING
from pymongo.asynchronous.collection import AsyncCollection
from pymongo.asynchronous.database import AsyncDatabase
from pymongo.errors import CollectionInvalid

Doc = dict[str, Any]

SHOWS = "shows"
SALES_BY_SECTOR = "sales_by_sector"
PRODUCER_STATEMENTS = "producer_statements"
ORDER_VIEW = "order_view"
LOT_TIMELINE = "lot_timeline"
PROCESSED_EVENTS = "processed_events"
# Fora das gerações: `eventId` dos fatos que já foram para o feed do painel
# (`analytics.live.activity`). Vence junto com o `processed_events`.
ACTIVITY_LOG = "activity_log"

# Os read models propriamente ditos: o que o replay reconstrói e compara.
READ_MODELS: tuple[str, ...] = (SHOWS, SALES_BY_SECTOR, PRODUCER_STATEMENTS, ORDER_VIEW, LOT_TIMELINE)
ALL_COLLECTIONS: tuple[str, ...] = (*READ_MODELS, PROCESSED_EVENTS)


def collection_name(base: str, generation: int) -> str:
    return f"{base}_g{generation}"


@dataclass(frozen=True)
class ReadModels:
    generation: int
    shows: AsyncCollection[Doc]
    sales: AsyncCollection[Doc]
    statements: AsyncCollection[Doc]
    orders: AsyncCollection[Doc]
    lots: AsyncCollection[Doc]
    processed: AsyncCollection[Doc]

    @classmethod
    def of(cls, db: AsyncDatabase[Doc], generation: int) -> "ReadModels":
        def get(base: str) -> AsyncCollection[Doc]:
            return db[collection_name(base, generation)]

        return cls(
            generation=generation,
            shows=get(SHOWS),
            sales=get(SALES_BY_SECTOR),
            statements=get(PRODUCER_STATEMENTS),
            orders=get(ORDER_VIEW),
            lots=get(LOT_TIMELINE),
            processed=get(PROCESSED_EVENTS),
        )


async def create_indexes(db: AsyncDatabase[Doc], generation: int, *, processed_ttl: timedelta) -> None:
    """Cria as coleções e os índices antes de consumir. Pode repetir: o que existe fica.

    As coleções nascem aqui, fora de transação: criar coleção dentro de uma
    transação funciona, mas disputa o catálogo do banco com as outras.
    """
    existing = set(await db.list_collection_names())
    for name in [collection_name(base, generation) for base in ALL_COLLECTIONS] + [ACTIVITY_LOG]:
        if name not in existing:
            with suppress(CollectionInvalid):  # outra instância criou antes
                await db.create_collection(name)
    ttl = int(processed_ttl.total_seconds())
    await db[ACTIVITY_LOG].create_index([("loggedAt", ASCENDING)], expireAfterSeconds=ttl)
    models = ReadModels.of(db, generation)
    # Lista de shows do produtor no painel, do mais novo para o mais antigo.
    await models.shows.create_index([("producerId", ASCENDING), ("_id", DESCENDING)])
    await models.sales.create_index([("showId", ASCENDING), ("hour", ASCENDING)])
    await models.orders.create_index([("showId", ASCENDING), ("_id", DESCENDING)])
    await models.orders.create_index([("showId", ASCENDING), ("status", ASCENDING), ("_id", DESCENDING)])
    # Pedidos confirmados no último minuto, a cada segundo, nas métricas do painel.
    await models.orders.create_index([("showId", ASCENDING), ("confirmedAt", ASCENDING)])
    await models.lots.create_index([("showId", ASCENDING)])
    await models.statements.create_index([("producerId", ASCENDING)])
    await models.processed.create_index([("processedAt", ASCENDING)], expireAfterSeconds=ttl)


async def drop(db: AsyncDatabase[Doc], generation: int) -> None:
    for base in ALL_COLLECTIONS:
        await db.drop_collection(collection_name(base, generation))


async def point_views(db: AsyncDatabase[Doc], generation: int) -> None:
    """Faz as views sem sufixo (`order_view`) apontarem para a geração ativa."""
    existing = {
        info["name"]: info async for info in await db.list_collections(filter={"name": {"$in": list(READ_MODELS)}})
    }
    for base in READ_MODELS:
        target = collection_name(base, generation)
        info = existing.get(base)
        if info is None:
            await db.command({"create": base, "viewOn": target, "pipeline": []})
        elif info.get("type") == "view" and info.get("options", {}).get("viewOn") != target:
            await db.command({"collMod": base, "viewOn": target, "pipeline": []})
