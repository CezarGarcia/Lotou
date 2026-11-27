# Keycloak e segurança no Lotou

O Lotou não tem código de login próprio. Quem cuida de usuários, senhas, sessões e tokens é o **Keycloak**, um servidor de identidade que fala OpenID Connect (OIDC) e OAuth 2.0, os mesmos padrões do "Entrar com Google" (ADR 19). Os serviços só conferem os tokens que ele emite.

## O login, passo a passo

A loja usa o fluxo **Authorization Code com PKCE**, o recomendado para apps no navegador: a senha só é digitada na tela do Keycloak, e o código que volta para a loja não serve para nada sem um segredo que só ela tem (ADR 27).

![Diagrama de sequência do login com Authorization Code e PKCE, entre comprador, loja Angular, Keycloak, gateway e serviço. O comprador clica em Entrar; a loja gera um segredo, o code_verifier, e o hash dele; redireciona para o login levando só o hash; o comprador digita usuário e senha na tela do Keycloak; o Keycloak volta para a loja com um código de uso único; a loja troca o código e o segredo por um access token de 5 minutos e um refresh token. Na chamada GET /api/v1/orders com o token, o gateway faz a primeira conferência (assinatura, emissor, validade e papel), encaminha o mesmo token, e o serviço confere de novo (ADR 21) antes de devolver os pedidos. Antes de vencer, a loja renova o token com o refresh token, sem pedir a senha.](img/keycloak-login-pkce.png)

O access token é um **JWT**: um JSON assinado pelo Keycloak com quem é a pessoa (`sub`) e os papéis dela. Qualquer serviço confere a assinatura com a chave pública do Keycloak, sem perguntar nada a ele a cada requisição.

## Papéis

| Papel | Quem tem | Pode |
| --- | --- | --- |
| `buyer` | todo comprador | reservar, pagar, ver e cancelar os próprios pedidos |
| `producer` | o produtor | criar shows, ver o painel e o relatório financeiro dos próprios shows, criar cupons, cancelar shows |
| `gate-staff` | a equipe da portaria | ler ingressos e ver o resumo das entradas |
| `service` | contas de serviço | chamar as APIs internas (`/internal/**`) |

Usuários de demonstração: `comprador`, `produtor` e `portaria`, todos com a senha `lotou123`. O Angular esconde o que o papel não permite (o link do painel só aparece para produtor), mas quem decide é o servidor: a tela é só conveniência.

## Duas conferências do token

![A loja manda o token ao api-gateway, que faz a primeira conferência (assinatura, emissor, validade, papel da rota e rate limit) e encaminha o mesmo token ao serviço, que confere de novo (assinatura, emissor, audiência, validade e papel). Os dois conferem a assinatura com a chave pública do Keycloak. Alguém na rede interna que pula o gateway chega ao serviço sem token válido e leva 401.](img/keycloak-dupla-conferencia.png)

O gateway barra antes requisições sem login, e os serviços conferem de novo. Assim, um serviço exposto por engano na rede interna não fica aberto (ADR 21).

## Serviços falando com serviços

Quando um serviço precisa de outro fora do Kafka, ele usa uma **conta de serviço** do Keycloak (client credentials): pede um token com o próprio segredo e o apresenta como qualquer outro cliente.

| Conta | Usa para |
| --- | --- |
| `notification-service` | buscar no Keycloak o e-mail do comprador na hora de enviar; ler o relatório financeiro no analytics para gerar o PDF |
| `order-service` | consultar no inventory a reserva de um pedido (`/internal/v1/reservations/{id}`): preço congelado e prazo |
| `lotou-seed`, `lotou-smoke` | o `make seed` e o `make smoke` criarem dados pela API, como um usuário faria |

As rotas `/internal/**` não existem no gateway: só são alcançáveis dentro da rede do Compose e exigem o papel `service`.

## Tempo real com login

- **SSE da loja** (posição na fila, mapa de cadeiras, status do pedido): o navegador lê o fluxo com `fetch`, e não com `EventSource`, para mandar o token no cabeçalho. Token na URL vazaria em logs, histórico e traces (ADR 27).
- **WebSocket do painel:** o token é enviado na primeira mensagem, e de novo a cada renovação, sem derrubar a conexão. O gateway só aceita a conexão vinda da origem da loja.

## Outras proteções

| Ameaça | Proteção |
| --- | --- |
| QR code falsificado ou editado | o QR leva o id do ingresso e uma assinatura Ed25519 do order-service; a portaria confere com a chave pública, sem ir ao banco e até sem internet, e quem tem a chave pública não consegue criar ingresso (ADR 38) |
| print do ingresso usado duas vezes | `SET NX` no Redis e constraint única no Postgres: só a primeira leitura entra. Sem internet, cada aparelho lembra o que já passou por ele, os portões podem ser divididos por setor, e a sincronização registra a entrada dupla com alerta (ADR 38) |
| robô comprando tudo na abertura | rate limit por usuário no gateway, fila virtual com sorteio, limite de 4 ingressos por CPF |
| clique duplo cobrando duas vezes | `Idempotency-Key` em todo POST que cria recurso |
| dado pessoal vazando | CPF gravado como HMAC (ADR 24); nenhum evento leva e-mail ou CPF; o Collector do OpenTelemetry mascara dados pessoais antes de gravar traces e logs |
| erro mostrando detalhes internos | respostas de erro no formato Problem Details (RFC 9457), com um código para o suporte e sem stack trace |

## Portaria sem internet

O QR é assinado pelo order-service com uma chave privada Ed25519, e a portaria confere com a chave pública. Isso deixa o leitor validar no próprio celular quando a internet do local cai, sem levar ao aparelho nada que sirva para criar ingresso (ADR 38).

![A portaria sem internet em três passos: com internet, o leitor baixa o pacote do show (os ingressos com setor e situação, a chave pública e a regra dos portões) a cada 2 minutos; sem resposta do servidor em 4 segundos, valida no celular a assinatura, a lista, o que já passou por ele e o setor do portão, e guarda a leitura; quando a rede volta, envia as leituras, a primeira entrada vale e as outras viram conflito com alerta. Embaixo, o caso do print: dois celulares do mesmo portão, os dois sem rede, liberam o mesmo QR, e a sincronização detecta a entrada dupla.](img/portaria-offline.png)

## A tela de login

O realm `lotou` usa um tema próprio (`infra/keycloak/themes/lotou`), só em CSS por cima do tema padrão do Keycloak, com as cores e as fontes da loja (ADR 36). Como os templates continuam os do Keycloak, uma atualização dele não quebra o login.

## Onde ver e onde está no código

- Administração: http://localhost:8180 (`admin`/`admin`), realm `lotou`.
- Para ver o que um token carrega, cole-o em qualquer decodificador de JWT local.

| O quê | Onde |
| --- | --- |
| Realm (papéis, clientes, usuários de demonstração) | [`infra/keycloak/lotou-realm.json`](../../infra/keycloak/lotou-realm.json) |
| Tema da tela de login | [`infra/keycloak/themes/lotou/`](../../infra/keycloak/themes/lotou/) |
| Login no Angular | [`apps/web/src/app/core/auth/`](../../apps/web/src/app/core/auth/) |
| Conferência do JWT e rate limit no gateway | `services/api-gateway/src/main/java/br/com/lotou/gateway/` |

Decisões relacionadas: [ADR 15](../adr/0015-qr-code-assinado-com-hmac.md) e [ADR 38](../adr/0038-portaria-offline-com-qr-ed25519.md) (QR assinado), [ADR 19](../adr/0019-keycloak-como-provedor-de-identidade.md) (Keycloak), [ADR 21](../adr/0021-servicos-revalidam-o-jwt.md) (serviços revalidam o JWT), [ADR 24](../adr/0024-cpf-como-hmac-e-limite-por-cpf-no-banco.md) (CPF como HMAC), [ADR 27](../adr/0027-oidc-e-sse-na-loja.md) (OIDC e SSE na loja).
