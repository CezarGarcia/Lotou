# 0013. Fila virtual só em shows de alta demanda

- **Status:** aceita
- **Data:** 2026-11-26

## Contexto

Na abertura de vendas de um show disputado, dezenas de milhares de pessoas chegam no mesmo minuto para poucos milhares de ingressos. Sem controle, todas batem no checkout ao mesmo tempo, e quem tem a conexão mais rápida (ou um robô) leva. A fila virtual controla quantas pessoas chegam ao checkout por segundo e decide a ordem de forma justa.

Na maioria dos shows, porém, não há disputa: uma fila só atrasaria o comprador.

## Decisão

A fila existe **só nos shows que o produtor marca como alta demanda**, e vale **durante toda a venda** desses shows:

- **Sala de espera:** abre 30 minutos antes das vendas. Quem entra não tem posição.
- **Sorteio na abertura:** as pessoas da sala recebem posições embaralhadas (`SecureRandom`). Chegar 30 minutos antes não dá vantagem sobre chegar 1 minuto antes, e robôs que entram cedo perdem a vantagem.
- **Depois da abertura:** quem chega entra no fim da fila, com a hora de chegada como posição; sempre atrás de quem estava na sala.
- **Admissão:** a cada segundo, os próximos N da fila (`ZPOPMIN`) recebem um token de 5 minutos. O N (`QUEUE_ADMISSION_RATE`) controla a carga no checkout.
- **A reserva confere o token** dentro do script Lua. Quem não reserva em 5 minutos perde a vez e volta ao fim da fila se entrar de novo.
- Com pouca gente, a admissão é imediata: a fila não atrapalha quando não há disputa.

A posição chega ao navegador por SSE, um evento por segundo, até a admissão. O sorteio e a admissão rodam sob lock distribuído, e o sorteio também confere dentro do script se já foi feito.

## Consequências

- O checkout recebe no máximo N pessoas novas por segundo por show, independentemente de quantas estejam na fila.
- A justiça vem do sorteio da sala, não da velocidade de quem chega primeiro na abertura.
- A fila é uma decisão de produto: o produtor escolhe. Um show marcado sem necessidade só faz o comprador esperar um segundo.
- A admissão é por usuário (o `sub` do token), não por pessoa: quem tem várias contas entra várias vezes. O limite de 4 ingressos por CPF continua valendo.
