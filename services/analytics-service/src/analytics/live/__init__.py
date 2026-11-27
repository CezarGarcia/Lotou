"""Painel ao vivo do produtor: feed de atividade, métricas a cada segundo e o WebSocket.

O protocolo está em `contracts/realtime-dashboard.md`. As peças:

- `activity`: entradas do feed montadas pela projeção e gravadas no Redis Stream
  `stream:activity:{showId}` depois que a transação do MongoDB confirma;
- `metrics`: o objeto `metrics`, calculado a partir dos read models da geração ativa;
- `hub`: o que cada instância faz no Redis (interesse pelos shows, publicação das
  métricas, repasse do pub/sub e leitura dos streams) e as assinaturas locais;
- `connection`: fila de envio de cada WebSocket, com o controle de cliente lento;
- `endpoint`: autenticação, assinaturas e mensagens do cliente.
"""
