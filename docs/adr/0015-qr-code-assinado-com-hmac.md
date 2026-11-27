# 0015. QR code do ingresso assinado com HMAC

- **Status:** substituída pelo ADR 38 (QR assinado com Ed25519); os códigos LOTOU1 continuam aceitos
- **Data:** 2026-11-26

## Contexto

O QR code é o ingresso: quem o apresenta na portaria entra. Se ele levasse só o ID do ingresso, qualquer pessoa que adivinhasse ou montasse um ID válido teria um QR que passa na primeira leitura, e a portaria precisaria ir ao banco a cada leitura para descobrir que é falso. No dia do show, com milhares de leituras por minuto e a portaria que precisa funcionar mesmo com outros serviços fora do ar (ADR 14), cada ida ao banco pesa.

## Decisão

- O conteúdo do QR é `LOTOU1.<ticketId>.<assinatura>`: a assinatura é o HMAC-SHA256 de `LOTOU1.<ticketId>` com uma chave secreta, em base64url sem padding.
- O order-service gera o código ao emitir o ingresso, grava junto com ele (índice único) e o publica em `TicketsIssued`. O notification-service só desenha o QR no PDF; a loja desenha o mesmo código em "Meus ingressos".
- A portaria (fase 6) confere a assinatura com a mesma chave (`TICKET_QR_KEY`), em tempo constante, antes de qualquer consulta: um QR falsificado é recusado sem ir ao banco. Só depois confere se o ingresso existe, não foi usado e não foi cancelado.
- O prefixo `LOTOU1` versiona o formato. Trocar a chave ou o algoritmo vira `LOTOU2`, e a portaria aceita as duas versões enquanto houver ingresso antigo válido.

## Consequências

- Forjar um ingresso exige a chave. Copiar um QR verdadeiro continua possível: a defesa contra a cópia é a portaria registrar a primeira entrada (`SET NX` e constraint única) e recusar a segunda. O QR que muda a cada 30 segundos fica como fase extra (questões em aberto).
- A chave é compartilhada entre o order-service e a portaria. Vazada, permite forjar ingressos até a troca; por isso fica fora do código, em variável de ambiente, e o formato já prevê a rotação.
- O código não traz dado pessoal: só o ID do ingresso e a assinatura.
