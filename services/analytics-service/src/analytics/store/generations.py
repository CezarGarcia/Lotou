"""Gerações dos read models e o ponteiro para a ativa.

Uma geração é o par (coleções `*_g<N>`, consumer group `<prefixo>.gen-<N>`). O
ponteiro `analytics_state/active` diz qual geração a API lê e qual o consumidor
ao vivo alimenta. O replay monta a geração N+1 com um consumer group novo, lendo
os tópicos do começo, e troca o ponteiro numa transação quando alcança o fim
(veja `analytics.replay`).

Ciclo de vida: BUILDING → ACTIVE → RETIRED → DROPPED, ou BUILDING → FAILED →
DROPPED. Quem apaga as coleções e o consumer group de uma geração aposentada é o
supervisor do processo do serviço, depois de um prazo de carência.
"""

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from enum import StrEnum
from typing import Any

from pymongo import ReturnDocument
from pymongo.asynchronous.client_session import AsyncClientSession
from pymongo.asynchronous.database import AsyncDatabase
from pymongo.asynchronous.mongo_client import AsyncMongoClient
from pymongo.errors import DuplicateKeyError

from analytics.store import read_models

Doc = dict[str, Any]

GENERATIONS = "generations"
STATE = "analytics_state"
_ACTIVE = "active"
_SEQUENCE = "generation-sequence"
_REPLAY_LOCK = "replay-lock"


class GenerationStatus(StrEnum):
    BUILDING = "BUILDING"
    ACTIVE = "ACTIVE"
    RETIRED = "RETIRED"
    FAILED = "FAILED"
    DROPPED = "DROPPED"


@dataclass(frozen=True)
class Generation:
    number: int
    status: GenerationStatus
    kind: str
    group_id: str
    created_at: datetime
    switched_at: datetime | None
    finished_at: datetime | None
    error: str | None
    end_offsets: list[Doc]
    events_applied: int | None

    @classmethod
    def from_doc(cls, doc: Doc) -> "Generation":
        return cls(
            number=doc["_id"],
            status=GenerationStatus(doc["status"]),
            kind=doc["kind"],
            group_id=doc["groupId"],
            created_at=doc["createdAt"],
            switched_at=doc.get("switchedAt"),
            finished_at=doc.get("finishedAt"),
            error=doc.get("error"),
            end_offsets=doc.get("endOffsets") or [],
            events_applied=doc.get("eventsApplied"),
        )


class ReplayInProgress(Exception):
    def __init__(self, generation: int | None) -> None:
        super().__init__(f"já existe um replay em andamento (geração {generation})")
        self.generation = generation


class LostReplayLock(Exception):
    """O lock do replay venceu ou foi tomado: este replay não pode trocar a geração."""


def utcnow() -> datetime:
    return datetime.now(UTC)


class GenerationRegistry:
    def __init__(
        self,
        client: AsyncMongoClient[Doc],
        db: AsyncDatabase[Doc],
        *,
        group_prefix: str,
        retired_grace: timedelta,
        processed_ttl: timedelta,
        replay_lease: timedelta,
    ) -> None:
        self._client = client
        self._db = db
        self._generations = db[GENERATIONS]
        self._state = db[STATE]
        self._group_prefix = group_prefix
        self._retired_grace = retired_grace
        self._processed_ttl = processed_ttl
        self._replay_lease = replay_lease

    @property
    def db(self) -> AsyncDatabase[Doc]:
        return self._db

    def group_id(self, generation: int) -> str:
        return f"{self._group_prefix}.gen-{generation}"

    # ------------------------------------------------------------- leitura

    async def active_generation(self) -> int | None:
        doc = await self._state.find_one({"_id": _ACTIVE})
        return int(doc["generation"]) if doc else None

    async def get(self, generation: int) -> Generation | None:
        doc = await self._generations.find_one({"_id": generation})
        return Generation.from_doc(doc) if doc else None

    async def latest(self, kind: str | None = None) -> Generation | None:
        query = {"kind": kind} if kind else {}
        doc = await self._generations.find_one(query, sort=[("_id", -1)])
        return Generation.from_doc(doc) if doc else None

    # ------------------------------------------------------- ciclo de vida

    async def ensure_active(self) -> int:
        """Devolve a geração ativa; na primeira subida, cria a geração 1 já ativa.

        A geração inicial lê os tópicos do começo como um replay, mas sem
        geração anterior para servir enquanto isso.
        """
        active = await self.active_generation()
        if active is not None:
            return active
        number = await self._next_number()
        await read_models.create_indexes(self._db, number, processed_ttl=self._processed_ttl)
        now = utcnow()

        async def bootstrap(session: AsyncClientSession) -> None:
            await self._generations.insert_one(
                self._new_doc(number, "bootstrap", GenerationStatus.ACTIVE, now) | {"switchedAt": now},
                session=session,
            )
            await self._state.insert_one({"_id": _ACTIVE, "generation": number, "switchedAt": now}, session=session)

        try:
            await self._transaction(bootstrap)
            return number
        except DuplicateKeyError:
            # Outra instância criou a geração inicial ao mesmo tempo: a dela vale.
            await self._generations.insert_one(
                self._new_doc(number, "bootstrap", GenerationStatus.FAILED, now)
                | {"error": "outra instância criou a geração inicial", "dropAfter": now, "finishedAt": now}
            )
            active = await self.active_generation()
            assert active is not None
            return active

    async def allocate(self, kind: str = "replay") -> int:
        """Reserva o número da próxima geração e cria as coleções dela."""
        number = await self._next_number()
        await read_models.create_indexes(self._db, number, processed_ttl=self._processed_ttl)
        await self._generations.insert_one(self._new_doc(number, kind, GenerationStatus.BUILDING, utcnow()))
        return number

    async def record_end_offsets(self, generation: int, end_offsets: list[Doc]) -> None:
        await self._generations.update_one({"_id": generation}, {"$set": {"endOffsets": end_offsets}})

    async def switch_to(self, generation: int, *, lock_owner: str, events_applied: int) -> int | None:
        """Troca o ponteiro para `generation` numa transação e aposenta a anterior.

        Confere, na mesma transação, que o replay ainda tem o lock e que a
        geração está em BUILDING. Devolve o número da geração aposentada.
        """
        now = utcnow()

        async def switch(session: AsyncClientSession) -> int | None:
            lock = await self._state.find_one({"_id": _REPLAY_LOCK}, session=session)
            if not lock or lock.get("owner") != lock_owner or lock["expiresAt"] <= now:
                raise LostReplayLock(f"o replay da geração {generation} perdeu o lock")
            # Gravar o lock garante conflito com quem tentar tomá-lo agora.
            await self._state.update_one({"_id": _REPLAY_LOCK}, {"$set": {"switchingAt": now}}, session=session)
            built = await self._generations.update_one(
                {"_id": generation, "status": GenerationStatus.BUILDING},
                {"$set": {"status": GenerationStatus.ACTIVE, "switchedAt": now, "eventsApplied": events_applied}},
                session=session,
            )
            if built.matched_count != 1:
                raise LostReplayLock(f"a geração {generation} não está mais em construção")
            pointer = await self._state.find_one_and_update(
                {"_id": _ACTIVE},
                {"$set": {"generation": generation, "switchedAt": now}},
                upsert=True,
                session=session,
            )
            previous = int(pointer["generation"]) if pointer else None
            if previous is not None:
                await self._generations.update_one(
                    {"_id": previous},
                    {
                        "$set": {
                            "status": GenerationStatus.RETIRED,
                            "finishedAt": now,
                            "dropAfter": now + self._retired_grace,
                        }
                    },
                    session=session,
                )
            return previous

        return await self._transaction(switch)

    async def mark_failed(self, generation: int, error: str) -> None:
        now = utcnow()
        await self._generations.update_one(
            {"_id": generation, "status": GenerationStatus.BUILDING},
            {"$set": {"status": GenerationStatus.FAILED, "error": error[:2000], "finishedAt": now, "dropAfter": now}},
        )

    async def droppable(self) -> list[int]:
        cursor = self._generations.find(
            {
                "status": {"$in": [GenerationStatus.RETIRED, GenerationStatus.FAILED]},
                "dropAfter": {"$lte": utcnow()},
            },
            projection={"_id": 1},
        )
        return [doc["_id"] async for doc in cursor]

    async def mark_dropped(self, generation: int) -> None:
        await self._generations.update_one(
            {"_id": generation, "status": {"$in": [GenerationStatus.RETIRED, GenerationStatus.FAILED]}},
            {"$set": {"status": GenerationStatus.DROPPED, "droppedAt": utcnow()}},
        )

    # ------------------------------------------------------ lock do replay

    async def acquire_replay_lock(self, owner: str) -> None:
        """Um replay por vez. Um lock vencido (processo que morreu) pode ser tomado."""
        now = utcnow()
        try:
            await self._state.find_one_and_update(
                {"_id": _REPLAY_LOCK, "$or": [{"owner": None}, {"expiresAt": {"$lte": now}}]},
                {
                    "$set": {
                        "owner": owner,
                        "generation": None,
                        "acquiredAt": now,
                        "expiresAt": now + self._replay_lease,
                    }
                },
                upsert=True,
                return_document=ReturnDocument.AFTER,
            )
        except DuplicateKeyError:
            held = await self._state.find_one({"_id": _REPLAY_LOCK})
            raise ReplayInProgress(held.get("generation") if held else None) from None
        # Uma construção que ficou em BUILDING é de um replay que perdeu o lock.
        abandoned = self._generations.find({"status": GenerationStatus.BUILDING}, projection={"_id": 1})
        async for doc in abandoned:
            await self.mark_failed(doc["_id"], "replay interrompido: o processo perdeu o lock")

    async def renew_replay_lock(self, owner: str, generation: int) -> None:
        now = utcnow()
        result = await self._state.update_one(
            {"_id": _REPLAY_LOCK, "owner": owner, "expiresAt": {"$gt": now}},
            {"$set": {"generation": generation, "expiresAt": now + self._replay_lease}},
        )
        if result.matched_count != 1:
            raise LostReplayLock(f"o replay da geração {generation} perdeu o lock")

    async def release_replay_lock(self, owner: str) -> None:
        await self._state.update_one(
            {"_id": _REPLAY_LOCK, "owner": owner},
            {"$set": {"owner": None, "expiresAt": None, "releasedAt": utcnow()}},
        )

    # ----------------------------------------------------------- internos

    async def _next_number(self) -> int:
        doc = await self._state.find_one_and_update(
            {"_id": _SEQUENCE},
            {"$inc": {"value": 1}},
            upsert=True,
            return_document=ReturnDocument.AFTER,
        )
        assert doc is not None
        return int(doc["value"])

    def _new_doc(self, number: int, kind: str, status: GenerationStatus, now: datetime) -> Doc:
        return {
            "_id": number,
            "status": status,
            "kind": kind,
            "groupId": self.group_id(number),
            "createdAt": now,
        }

    async def _transaction[T](self, callback: Callable[[AsyncClientSession], Awaitable[T]]) -> T:
        async with self._client.start_session() as session:
            return await session.with_transaction(callback)
