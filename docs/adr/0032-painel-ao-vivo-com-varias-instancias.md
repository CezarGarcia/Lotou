# 0032. Painel ao vivo com várias instâncias do analytics: interesse, cálculo por segundo e feed sem repetição

- **Status:** aceita
- **Data:** 2026-11-27

## Contexto

O painel do produtor recebe, por WebSocket, as métricas do show a cada segundo e um feed de atividade (ADRs 17 e 31). O protocolo está em `contracts/realtime-dashboard.md`; as métricas saem no pub/sub `dashboard.metrics:{showId}` e o feed no stream `stream:activity:{showId}` (ADR 11). O analytics roda com mais de uma instância, cada uma com os seus WebSockets, e consome o Kafka num consumer group só. Quatro perguntas ficavam abertas:

1. **Quem calcula as métricas.** Calcular em toda instância, para todo show, multiplica as leituras no MongoDB pelo número de instâncias e publica a mesma coisa várias vezes. Calcular sem ninguém assistindo é desperdício.
2. **Como saber que alguém assiste um show** se o WebSocket está em outra instância.
3. **O feed sem repetição.** O Kafka entrega ao menos uma vez, e na troca de geração do replay (ADR 30) o consumidor ao vivo da geração nova reaplica os eventos que a geração antiga aplicou enquanto o replay rodava. Para os read models isso não importa (cada geração tem o seu `processed_events`), mas o feed é um só.
4. **Cliente lento.** Uma aba em rede ruim não pode atrasar as outras conexões da instância.

## Decisão

- **Interesse num ZSET com prazo.** Cada instância renova, a cada segundo, os shows que têm assinante nela em `dashboard:watched` (membro = showId, score = até quando vale, em ms, 5 s à frente). Quem publica descarta os vencidos e lê o resto num comando só. Uma instância que morre para de renovar e o interesse dela vence sozinho; não há chave por show para varrer com `SCAN`.
- **Um cálculo por show por segundo, sem líder.** No começo de cada segundo, toda instância lê os shows assistidos e disputa o segundo corrente de cada um num script Lua: `dashboard:metrics-tick:{showId}` guarda o último segundo calculado, e só quem grava um segundo maior calcula e publica. O trabalho se espalha entre as instâncias e nenhuma é especial: sem eleição de líder, cair uma não deixa show sem métrica nem exige failover.
- **Métricas dos read models.** O objeto `metrics` sai da geração ativa (`sales_by_sector` somado por setor, relatório, linha do tempo dos lotes e catálogo) e um índice (showId, confirmedAt) no `order_view` conta os pedidos do último minuto. Nenhum contador novo no Redis precisa ficar coerente com os read models.
- **Repasse local.** Cada instância tem uma conexão de pub/sub, que assina só os canais dos shows com assinante nela, e um `XREAD BLOCK` só, em todos os streams desses shows, com um cursor por stream. Não há uma conexão do Redis por WebSocket.
- **Nada se perde entre a foto e o ao vivo.** A assinatura é registrada antes da foto (`XREVRANGE` das últimas 50); o que o leitor traz enquanto a foto é montada fica guardado nela, e cada assinatura só recebe entradas com ID maior que o último que já recebeu.
- **Feed uma vez por evento.** A projeção grava o `eventId` em `activity_log` (fora das gerações, com o mesmo prazo do `processed_events`) na mesma transação do efeito, e só devolve a entrada do feed se o registro é novo. Só o consumidor ao vivo faz isso; o replay não escreve no feed. O `XADD` acontece depois da transação, com `IDMP` (Redis 8.6+) e o `eventId`, para uma nova tentativa depois de um timeout não gravar a entrada duas vezes.
- **No máximo uma vez no feed.** Se o processo cair entre a transação e o `XADD`, a entrada se perde: o evento já está no `processed_events` e não volta. É aceitável para um feed, porque os números do painel vêm dos read models; gravar antes da transação poria no feed fatos que podem não ter sido aplicados.
- **Cliente lento.** Cada WebSocket tem uma fila e uma task que envia. Métricas são substituíveis: fica só a mais recente de cada show ainda não enviada. Atividade nunca é descartada: se a fila passa de 500 frames, ou um envio fica parado 10 s, a conexão fecha com 1013, e o cliente reconecta e recebe a foto.

## Consequências

- Com N instâncias, cada show assistido custa um cálculo por segundo no total, não N. O custo de um show sem ninguém olhando é zero.
- O `MAXLEN ~ 1000` do stream e o prazo de 5 s do interesse são os únicos limites; um leitor que ficar mais de 1.000 entradas atrás de um show perde o meio, e o painel se corrige na próxima métrica.
- Um painel que demora a ler perde segundos de métrica, nunca uma linha do feed; um que trava de vez é desconectado em vez de segurar memória.
- O `IDMP` exige Redis 8.6 ou mais novo (o Compose usa 8.8).
- O painel não usa `metrics:sectors:{showId}`: as vendas por setor vêm do `sales_by_sector`, que já é idempotente e reconstruído pelo replay.
- As tarefas de fundo (interesse, cálculo, pub/sub, `XREAD`) ficam fora do OpenTelemetry, para não gerar um trace por segundo; o `XADD` aparece no trace do evento do Kafka e a foto no span do `subscribe`.
