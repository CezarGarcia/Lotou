# 0005. Bitmap no Redis para o status dos assentos

- **Status:** aceita
- **Data:** 2026-11-26

## Contexto

O mapa de assentos é a tela mais disputada da abertura de vendas: todo comprador de cadeira numerada o abre, e muitos o recarregam. Ele precisa mostrar, para cada cadeira do setor, se está livre ou ocupada, e um setor pode ter milhares de cadeiras.

As alternativas eram:

1. **Consultar o Postgres** a cada abertura do mapa: uma linha por cadeira, com o status. Milhares de compradores lendo milhares de linhas, no mesmo banco que grava as reservas.
2. **Cache do mapa** com TTL: alivia o banco, mas mostra cadeiras ocupadas como livres por alguns segundos, e o comprador escolhe uma cadeira que já foi.
3. **Bitmap no Redis**, mantido pela própria reserva.

## Decisão

Cada setor de cadeira numerada tem um bitmap no `redis-core`, `seatmap:{showId}:{sectorId}`, com **um bit por cadeira**: 1 é ocupada (segurada ou vendida), 0 é livre. A posição do bit é a ordem da cadeira no mapa.

- O script Lua da reserva liga os bits na mesma operação atômica que segura as cadeiras; a devolução os desliga. O bitmap nunca diverge das chaves `seat:{showId}:{seatId}`.
- A leitura do mapa é um `GET` da chave inteira: um setor de 5 mil cadeiras cabe em 625 bytes.
- O status dos assentos nunca vem de cache. O que muda depois da leitura chega ao navegador pelo pub/sub `seatmap.{showId}` (ADR 11).
- A carga do estoque, na abertura das vendas, monta o bitmap a partir do Postgres; a mesma carga o reconstrói se o Redis perder os dados (ADR 26).

## Consequências

- Abrir o mapa não toca no Postgres, por mais compradores que haja.
- O bitmap só diz livre ou ocupado. Quem segurou e se a cadeira já foi paga ficam nas chaves `seat:*` e no Postgres, que é onde importam.
- A posição de cada cadeira precisa ser estável: ela vem da ordem das fileiras no local e não muda depois que as vendas abrem.
- O mapa desenhado ainda depende do layout (fileiras e cadeiras), que vem do event-service e não muda durante a venda.
