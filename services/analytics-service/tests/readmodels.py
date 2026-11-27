"""Ajudantes para ler e comparar gerações dos read models nos testes."""

from typing import Any

from pymongo.asynchronous.database import AsyncDatabase

from analytics.store.read_models import READ_MODELS, collection_name

Snapshot = dict[str, list[dict[str, Any]]]


async def snapshot(db: AsyncDatabase[dict[str, Any]], generation: int) -> Snapshot:
    """Todos os documentos dos read models de uma geração, ordenados pelo `_id`.

    `processed_events` fica de fora: é controle de idempotência, guarda a hora do
    processamento e não é read model.
    """
    return {
        base: await db[collection_name(base, generation)].find().sort("_id", 1).to_list(None) for base in READ_MODELS
    }


def assert_same(left: Snapshot, right: Snapshot) -> None:
    """Compara coleção a coleção, para a falha dizer onde está a diferença."""
    assert left.keys() == right.keys()
    for base in left:
        left_ids = [doc["_id"] for doc in left[base]]
        right_ids = [doc["_id"] for doc in right[base]]
        assert left_ids == right_ids, f"{base}: documentos diferentes"
        for a, b in zip(left[base], right[base], strict=True):
            if a != b:
                fields = sorted({key for key in a.keys() | b.keys() if a.get(key) != b.get(key)})
                diff = {key: (a.get(key), b.get(key)) for key in fields}
                raise AssertionError(f"{base}/{a['_id']} difere: {diff}")
