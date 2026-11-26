"""Operações administrativas no Kafka: partições dos tópicos e remoção do consumer group de uma geração."""

import logging
from collections.abc import Sequence

from aiokafka import TopicPartition
from aiokafka.admin import AIOKafkaAdminClient
from aiokafka.errors import GroupIdNotFound, for_code
from aiokafka.protocol.admin import DeleteGroupsRequest

logger = logging.getLogger(__name__)


async def partitions(bootstrap_servers: str, topics: Sequence[str]) -> list[TopicPartition]:
    """Partições dos tópicos. Tópico inexistente é erro: o replay não pode pular um tópico."""
    admin = AIOKafkaAdminClient(bootstrap_servers=bootstrap_servers, client_id="analytics-service-admin")
    await admin.start()
    try:
        described = await admin.describe_topics(list(topics))
    finally:
        await admin.close()
    found = {entry["topic"]: entry for entry in described if entry["error_code"] == 0 and entry["partitions"]}
    missing = [topic for topic in topics if topic not in found]
    if missing:
        raise RuntimeError(f"tópicos inexistentes no Kafka: {', '.join(missing)}")
    return [
        TopicPartition(topic, partition["partition"])
        for topic in topics
        for partition in sorted(found[topic]["partitions"], key=lambda p: p["partition"])
    ]


async def delete_consumer_group(bootstrap_servers: str, group_id: str) -> None:
    """Apaga o consumer group (offsets incluídos). Grupo que não existe não é erro.

    O `AIOKafkaAdminClient` não tem `delete_consumer_groups`; a requisição
    `DeleteGroups` é mandada direto ao coordenador do grupo. Um grupo com membros
    ativos é recusado pelo broker (`NonEmptyGroup`), e quem chamou tenta depois.
    """
    admin = AIOKafkaAdminClient(bootstrap_servers=bootstrap_servers, client_id="analytics-service-admin")
    await admin.start()
    try:
        coordinator = await admin.find_coordinator(group_id)
        response = await admin._send_request_to_node(coordinator, DeleteGroupsRequest([group_id]))
        for group, error_code in response.results:
            if error_code == 0:
                logger.info("Consumer group apagado", extra={"consumerGroup": group})
                continue
            error = for_code(error_code)
            if error is GroupIdNotFound:
                continue
            raise error(f"não foi possível apagar o consumer group {group}")
    finally:
        await admin.close()
