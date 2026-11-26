# 0019. Keycloak como provedor de identidade

- **Status:** aceita
- **Data:** 2026-11-26

## Contexto

O Lotou tem três tipos de usuário com permissões diferentes: o comprador (loja), o produtor (painel) e a equipe da portaria (leitor de QR). Todos os serviços atrás do gateway precisam saber quem está chamando e com qual papel.

As alternativas eram:

1. **Login e JWT feitos à mão** num serviço próprio: cadastro, hash de senha, emissão e rotação de chaves, refresh token, recuperação de senha.
2. **Um provedor de identidade pronto**, falando OAuth 2.0 e OpenID Connect.

Autenticação própria é código arriscado (um erro vira vazamento de conta) e não tem relação com o que o projeto quer provar, que é concorrência, consistência e observabilidade. Entre os provedores prontos, o Keycloak é open source, roda num container, é comum no mercado brasileiro e importa a configuração inteira de um arquivo, o que mantém a promessa de subir tudo com um `docker compose up`.

## Decisão

Usar o **Keycloak** como provedor de identidade, com OAuth 2.0 e OpenID Connect.

- Um realm `lotou`, importado automaticamente de `infra/keycloak/lotou-realm.json` quando o Compose sobe.
- Três papéis de realm, com os nomes que vão para o código: `buyer` (comprador), `producer` (produtor) e `gate-staff` (portaria).
- O Angular é um cliente público e autentica com o fluxo Authorization Code + PKCE. Nenhum segredo fica no navegador.
- O api-gateway é um resource server: valida a assinatura do JWT com a chave pública do realm (JWKS), o emissor e a validade. Ele não chama o Keycloak a cada requisição.
- Processos sem usuário (como o seed) usam o fluxo client credentials, com um cliente confidencial e uma conta de serviço.
- O Keycloak guarda seus dados no Postgres do Compose, num banco só dele.

## Consequências

- Nenhum serviço do Lotou guarda senha ou emite token. Cadastro, login, recuperação de senha e rotação de chaves ficam por conta do Keycloak.
- Os serviços dependem só do padrão (JWT, JWKS e OIDC), não do Keycloak em si. Trocar por outro provedor compatível é mudança de configuração.
- É mais um container, e dos mais pesados do ambiente (JVM, cerca de 500 MB de memória). Entra na conta da questão em aberto sobre memória.
- O token é validado localmente, então revogar um acesso só vale quando o token expira. Por isso o access token tem vida curta (5 minutos).
- O arquivo do realm vira parte do código: mudanças de papéis e clientes passam por revisão e ficam no histórico do Git. As senhas e os segredos que estão nele são de desenvolvimento e não servem para um ambiente real.
