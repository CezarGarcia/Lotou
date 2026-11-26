"""Aplica um evento aos read models de uma geração, dentro de uma transação.

Idempotência: o `eventId` vai para `processed_events` na mesma transação do
efeito. Um evento repetido (o Kafka entrega ao menos uma vez) encontra o seu
`eventId` e não faz nada. Se duas instâncias aplicarem o mesmo evento ao mesmo
tempo, as duas inserem o mesmo `_id`: uma recebe conflito, repete a transação,
encontra o `eventId` e para.

Ordem: só é garantida por chave (pedido no `order.events`, show no catálogo e
no inventory). Cada read model é montado para não depender dela:

- `shows` guarda a versão mais alta do show; uma versão menor é ignorada.
- `order_view` anda pela tabela de transições (`analytics.domain.orders`).
- `sales_by_sector` e os contadores do relatório só somam, e só quando o pedido
  entra no estado (um OrderConfirmed com outro `eventId` não soma duas vezes).
- Um pedido pode chegar antes do show (tópicos e partições diferentes): o
  `order_view` nasce com `show: null` e o título é preenchido quando o show
  chega. Para essa cópia nunca ficar velha, a transação que cria um
  `order_view` e a transação do catálogo gravam o mesmo documento
  (`producer_statements` do show); o MongoDB não deixa as duas passarem juntas,
  e a que perde repete com o estado novo.
"""

import logging
from dataclasses import dataclass
from enum import StrEnum
from typing import Any

from bson.int64 import Int64
from pymongo.asynchronous.client_session import AsyncClientSession
from pymongo.asynchronous.database import AsyncDatabase

from analytics.contracts import (
    Event,
    LotOpened,
    LotSoldOut,
    OrderCancelled,
    OrderConfirmed,
    OrderCreated,
    ShowSnapshot,
    TicketsIssued,
)
from analytics.domain import hour_bucket, orders, shows, statement
from analytics.store.generations import utcnow
from analytics.store.read_models import ReadModels

logger = logging.getLogger(__name__)

Doc = dict[str, Any]


class Outcome(StrEnum):
    APPLIED = "applied"
    DUPLICATE = "duplicate"


@dataclass(frozen=True)
class Source:
    """De onde a mensagem veio, para o registro do `processed_events` e a DLT."""

    topic: str
    partition: int
    offset: int


class Projector:
    def __init__(self, db: AsyncDatabase[Doc], generation: int) -> None:
        self.models = ReadModels.of(db, generation)

    @property
    def generation(self) -> int:
        return self.models.generation

    async def apply(self, event: Event, source: Source, session: AsyncClientSession) -> Outcome:
        models = self.models
        seen = await models.processed.find_one({"_id": event.event_id}, projection={"_id": 1}, session=session)
        if seen is not None:
            return Outcome.DUPLICATE

        match event.payload:
            case ShowSnapshot() as show:
                await self._show(show, session)
            case OrderCreated() | OrderConfirmed() | OrderCancelled() | TicketsIssued() as order:
                await self._order(event, order, session)
            case LotOpened() | LotSoldOut() as lot:
                await self._lot(event, lot, session)

        await models.processed.insert_one(
            {
                "_id": event.event_id,
                "type": event.type,
                "topic": source.topic,
                "partition": source.partition,
                "offset": source.offset,
                "occurredAt": event.envelope.occurred_at,
                "processedAt": utcnow(),
            },
            session=session,
        )
        return Outcome.APPLIED

    # ------------------------------------------------------------ catálogo

    async def _show(self, show: ShowSnapshot, session: AsyncClientSession) -> None:
        models = self.models
        current = await models.shows.find_one({"_id": show.show_id}, session=session)
        if current is not None and current["version"] >= show.version:
            return  # versão antiga ou repetida: fica a mais alta

        doc = shows.to_doc(show)
        await models.shows.replace_one({"_id": show.show_id}, doc, upsert=True, session=session)

        summary = shows.summary(doc)
        if summary != shows.summary(current):
            # Preenche (ou atualiza) o show nos pedidos que chegaram antes dele.
            await models.orders.update_many({"showId": show.show_id}, {"$set": {"show": summary}}, session=session)

        current_statement = await models.statements.find_one({"_id": show.show_id}, session=session)
        updated = current_statement or statement.new(show.show_id)
        statement.attach_show(updated, doc)
        await models.statements.replace_one({"_id": show.show_id}, updated, upsert=True, session=session)

    # -------------------------------------------------------------- pedido

    async def _order(
        self,
        event: Event,
        order: OrderCreated | OrderConfirmed | OrderCancelled | TicketsIssued,
        session: AsyncClientSession,
    ) -> None:
        models = self.models
        view = await models.orders.find_one({"_id": order.order_id}, session=session)
        show_doc = None
        if view is None:
            show_doc = await models.shows.find_one({"_id": order.show_id}, session=session)
        change = orders.apply(view, event, shows.summary(show_doc))

        if change.step is orders.Step.REFUSED:
            logger.warning(
                "Transição de pedido fora da tabela: evento ignorado",
                extra={
                    "orderId": order.order_id,
                    "eventId": event.event_id,
                    "eventType": event.type,
                    "currentStatus": view["status"] if view else None,
                },
            )
        if change.view != view:
            await models.orders.replace_one({"_id": order.order_id}, change.view, upsert=True, session=session)

        if not change.statement.is_empty():
            current = await models.statements.find_one({"_id": order.show_id}, session=session)
            if current is None:
                current = statement.new(order.show_id)
                show_doc = show_doc or await models.shows.find_one({"_id": order.show_id}, session=session)
                if show_doc is not None:
                    statement.attach_show(current, show_doc)
            statement.add(current, change.statement, event.envelope.occurred_at)
            await models.statements.replace_one({"_id": order.show_id}, current, upsert=True, session=session)

        if change.sales:
            assert change.sold_at is not None
            await self._sales(order.show_id, change.sales, change.sold_at, session)

    async def _sales(
        self, show_id: str, lines: list[orders.SaleLine], sold_at: Any, session: AsyncClientSession
    ) -> None:
        hour = hour_bucket(sold_at)
        by_sector: dict[str, list[orders.SaleLine]] = {}
        for line in lines:
            by_sector.setdefault(line.sector_id, []).append(line)
        for sector_id, sector_lines in by_sector.items():
            increments: dict[str, Any] = {
                "ticketsSold": sum(line.tickets for line in sector_lines),
                "revenueCents": Int64(sum(line.revenue_cents for line in sector_lines)),
                "orders": 1,
            }
            for line in sector_lines:
                increments[f"lots.{line.lot_id}.ticketsSold"] = line.tickets
                increments[f"lots.{line.lot_id}.revenueCents"] = Int64(line.revenue_cents)
            await self.models.sales.update_one(
                {"_id": f"{show_id}:{sector_id}:{hour:%Y-%m-%dT%H}"},
                {
                    "$setOnInsert": {"showId": show_id, "sectorId": sector_id, "hour": hour},
                    "$inc": increments,
                },
                upsert=True,
                session=session,
            )

    # ---------------------------------------------------------- inventory

    async def _lot(self, event: Event, lot: LotOpened | LotSoldOut, session: AsyncClientSession) -> None:
        entry: Doc
        match lot:
            case LotOpened():
                entry = {
                    "type": "OPENED",
                    "at": lot.opened_at,
                    "priceCents": Int64(lot.price_cents),
                    "available": lot.available,
                }
            case LotSoldOut():
                entry = {"type": "SOLD_OUT", "at": lot.sold_out_at}
        entry["eventId"] = event.event_id
        await self.models.lots.update_one(
            {"_id": f"{lot.show_id}:{lot.lot_id}"},
            {
                "$setOnInsert": {"showId": lot.show_id, "sectorId": lot.sector_id, "lotId": lot.lot_id},
                # Ordenada pela hora do fato, não pela de chegada.
                "$push": {"transitions": {"$each": [entry], "$sort": {"at": 1, "eventId": 1}}},
            },
            upsert=True,
            session=session,
        )
