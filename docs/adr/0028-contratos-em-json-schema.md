# 0028. Contratos dos eventos em JSON Schema, com exemplos

- **Status:** aceita
- **Data:** 2026-11-26

## Contexto

Os eventos passam entre serviços em Java, Node e Python. Sem um contrato escrito, cada lado descobre o formato do outro em produção. O documento deixava em aberto JSON Schema ou Avro com Schema Registry.

Avro com Schema Registry dá mensagens menores e confere a compatibilidade na hora de publicar, mas acrescenta um serviço, um formato binário que não se lê no Kafka UI e geração de código nas três linguagens.

## Decisão

- **JSON Schema (draft 2020-12)** na pasta `contracts/`, um arquivo por tipo e versão de mensagem (`order.events/OrderConfirmed.v1.schema.json`).
- **Envelope único:** `eventId` (UUID v7), `type`, `version`, `occurredAt` e `payload`. A chave da mensagem é o ID do agregado e o trace vai no cabeçalho `traceparent`.
- **Cada schema é autocontido**, sem `$ref` para outros arquivos, para que os validadores das três linguagens funcionem sem configurar resolução de referências.
- **Um exemplo válido por mensagem** em `contracts/examples/`. O produtor valida o que publica contra o schema nos testes, o consumidor testa a leitura com o exemplo, e o CI confere que todo schema tem exemplo e que o exemplo passa.
- **Versionamento:** campo novo e opcional não muda a versão. Remover, renomear ou mudar o tipo de um campo cria uma versão nova, e o produtor publica as duas enquanto houver consumidor da antiga. O consumidor ignora tipos que não conhece.

## Consequências

- As mensagens se leem no Kafka UI e nos logs, e um consumidor em qualquer linguagem só precisa de um parser de JSON.
- A compatibilidade não é conferida pelo broker na hora de publicar: depende dos testes de contrato. Se o projeto crescer, o Schema Registry com JSON Schema é o passo seguinte, sem trocar o formato.
- Os schemas repetem trechos comuns (o show inteiro aparece em `ShowPublished` e `ShowUpdated`). É o preço de não usar `$ref`.
