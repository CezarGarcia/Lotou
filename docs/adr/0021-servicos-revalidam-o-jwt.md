# 0021. Os serviços revalidam o JWT que o gateway já validou

- **Status:** aceita
- **Data:** 2026-11-26

## Contexto

O api-gateway valida o JWT de toda requisição que exige autenticação (ADR 19). Falta decidir como o serviço atrás dele fica sabendo quem é o usuário e quais papéis ele tem. O event-service precisa disso para duas coisas: exigir o papel `producer` na escrita e garantir que só o dono edita e publica um show.

As alternativas eram:

1. **Confiar no gateway.** O gateway valida o token e repassa cabeçalhos como `X-User-Id` e `X-User-Roles`; o serviço acredita neles. É simples, mas qualquer processo que alcance o serviço pela rede interna pode se passar por qualquer usuário, e um erro de rota no gateway vira uma rota aberta.
2. **O serviço valida o token de novo.** O gateway repassa o cabeçalho `Authorization` como chegou, e cada serviço confere assinatura, emissor, audiência e validade.

## Decisão

Cada serviço **valida o JWT por conta própria** (defesa em profundidade):

- O gateway continua sendo a primeira barreira: recusa cedo o que não tem token válido e aplica as regras de papel por rota.
- O gateway repassa o `Authorization` sem alterar. O serviço valida a assinatura com as chaves públicas do realm (JWKS, em cache local), o emissor, a audiência `lotou-api` e a validade.
- No serviço, toda rota exige autenticação por padrão. Rota pública é marcada com `@Public()`, e papel exigido com `@Roles()`. Esquecer de anotar uma rota nova a deixa fechada, não aberta.
- O ID do usuário vem do claim `sub` e os papéis de `realm_access.roles`. Nenhum serviço lê identidade de cabeçalho montado por outro serviço.

## Consequências

- Um serviço exposto por engano, ou chamado de dentro da rede, não aceita requisição sem um token válido do Keycloak.
- A validação é local e custa uma verificação de assinatura por requisição. As chaves são baixadas uma vez e rebuscadas só quando aparece um `kid` desconhecido, então o Keycloak não entra no caminho de cada requisição.
- A configuração de autenticação (emissor, URL do JWKS e audiência) se repete em cada serviço. No Compose ela fica num bloco único, reaproveitado.
- As regras de papel existem em dois lugares, no gateway e no serviço. A regra do serviço é a que vale; a do gateway é uma otimização e pode ser mais grossa.
- Chamadas entre serviços sem um usuário (jobs, seed) precisam de token próprio, obtido por client credentials.
