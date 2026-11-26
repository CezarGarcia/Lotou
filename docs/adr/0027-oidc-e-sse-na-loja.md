# 0027. Login com angular-auth-oidc-client e SSE lido com fetch na loja

- **Status:** aceita
- **Data:** 2026-11-26

## Contexto

A fase 2 leva a compra para a loja Angular, e com ela duas necessidades:

1. **Login** no Keycloak pelo fluxo Authorization Code com PKCE (ADR 19), com renovação do token e volta à página em que o comprador estava.
2. **Fluxos SSE** da posição na fila e do mapa de assentos. Os dois exigem o token de acesso, porque a posição é de cada comprador.

Para o login, as opções eram `keycloak-js` (o adaptador oficial, preso ao Keycloak), `angular-oauth2-oidc` e `angular-auth-oidc-client`, as duas genéricas para qualquer provedor OpenID Connect.

Para o SSE, o `EventSource` do navegador não deixa mandar cabeçalhos. O token teria de ir na URL, onde aparece em logs de proxy, no histórico e nos traces.

## Decisão

- **`angular-auth-oidc-client`**, certificada pela OpenID Foundation, com suporte a standalone components e signals e mantida em dia com as versões do Angular. Não amarra a loja ao Keycloak: trocar de provedor é mudar o `authority`. A loja usa guard e interceptor próprios, pequenos: o interceptor só põe o token nas chamadas `/api/` do mesmo domínio, para o token nunca vazar para outra origem.
- A loja pede só `openid profile`. O e-mail não é usado e fica fora do token.
- **SSE lido com `fetch`** e um parser incremental próprio, em vez do `EventSource`. O token vai no cabeçalho `Authorization`, como em qualquer outra chamada. A reconexão usa espera exponencial com jitter, manda `Last-Event-ID`, respeita `Retry-After` e lê o token de novo a cada tentativa, porque ele pode ter sido renovado. Um 4xx encerra o fluxo em vez de tentar para sempre.
- O nginx da loja serve os caminhos `/api/.../events` sem buffer e sem compressão, com leitura de até 1 hora.

## Consequências

- A biblioteca de OIDC soma cerca de 120 kB ao pacote inicial, porque a sessão é resolvida antes da primeira rota. O orçamento de aviso do pacote inicial subiu de 500 para 600 kB.
- O leitor de SSE é código nosso para manter, coberto por testes do parser e da reconexão. Em troca, o token nunca aparece numa URL.
- O mapa de assentos começa com uma leitura comum do mapa e passa ao fluxo SSE; se o fluxo for recusado, volta a consultar a cada 10 s.
