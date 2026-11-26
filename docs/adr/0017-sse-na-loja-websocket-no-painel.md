# 0017. SSE na loja, WebSocket no painel

- **Status:** aceita
- **Data:** 2026-11-26

## Contexto

Há dois tipos de tempo real no Lotou. Na loja, o servidor só empurra dados ao comprador: a posição na fila e as cadeiras que mudam no mapa. No painel do produtor, o cliente também fala: escolhe quais shows acompanhar, troca de show, renova o token, e recebe métricas a cada segundo e um feed de atividade.

## Decisão

- **SSE na loja.** É HTTP comum: passa pelo gateway e pelo nginx sem nada especial além de desligar o buffer, reconecta com `Last-Event-ID` e não exige protocolo próprio. A loja lê com `fetch`, para mandar o token no cabeçalho (ADR 27).
- **WebSocket no painel.** Um canal só por aba, nos dois sentidos: o cliente assina e cancela shows na mesma conexão, e o servidor manda métricas e atividade de vários shows. O protocolo está em `contracts/realtime-dashboard.md`.
- O token do WebSocket vai na **primeira mensagem**, não na URL nem num cabeçalho (o navegador não deixa mandar cabeçalho na abertura do WebSocket). O servidor fecha a conexão se a autenticação não chegar em 5 s.

## Consequências

- Usar os dois é proposital: cada um onde é melhor, e o README explica a escolha.
- O gateway e o nginx precisam encaminhar o `Upgrade` do WebSocket, e a rota do painel no gateway é aberta: quem autentica é o analytics, na primeira mensagem.
- Um WebSocket por aba do painel mantém uma conexão por produtor conectado. O analytics escala horizontalmente porque cada instância lê as métricas e a atividade do Redis, não da memória de outra instância.
