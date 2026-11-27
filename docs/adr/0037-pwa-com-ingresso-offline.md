# 0037. A loja como PWA, com os ingressos salvos no aparelho para abrir sem internet

- **Status:** aceita
- **Data:** 2026-11-27

## Contexto

O comprador mostra o ingresso na porta do show, que é justamente onde o celular costuma ficar sem sinal: milhares de pessoas no mesmo lugar saturam a antena. A loja é um app web. Sem internet, ela não abria, e o QR, que o Angular desenha a partir do código do ingresso que vem da API, não aparecia. O único jeito de ter o ingresso offline era ter baixado o PDF do e-mail.

As saídas comuns são um app nativo, o ingresso na Apple Wallet ou no Google Wallet, ou o próprio site funcionando offline. O usuário decidiu deixar a Wallet para depois (ela exige conta de desenvolvedor da Apple e de emissor no Google).

## Decisão

- **A loja vira um PWA** com o service worker oficial do Angular (`@angular/service-worker`). Ele guarda no aparelho o app inteiro (HTML, JavaScript, CSS, inclusive o pacote que desenha o QR) na primeira visita, e as aberturas seguintes funcionam sem rede. O manifesto deixa instalar a loja na tela inicial, com o ícone do Lotou. Respostas da API não passam pelo cache do service worker: dado pessoal não fica num cache genérico por URL.
- **Uma carteira de ingressos no aparelho** (`TicketWallet`). Com internet e login, a loja guarda no `localStorage` os ingressos válidos dos próximos shows: o show, o setor, a cadeira e o código assinado do QR. A carteira é atualizada ao entrar, ao abrir "Meus ingressos" e ao ver um pedido, que já guarda o ingresso recém-comprado. Ingresso cancelado sai na próxima atualização; show que passou há mais de 12 horas é descartado na leitura.
- **Uma página pública, "Ingressos salvos"** (`/ingressos-salvos`), que lê só a carteira: abre sem internet e sem login (o token do Keycloak não sobrevive ao fechamento do app, e o Keycloak não abre offline). O QR é desenhado no próprio aparelho.
- **Sem internet, as telas que pedem login levam a essa página**, em vez de tentar o Keycloak. Uma faixa no cabeçalho avisa que o aparelho está sem rede.
- **O logout apaga a carteira**, e o login de outra pessoa no mesmo aparelho também.

## Alternativas consideradas

- **Cache das respostas da API no service worker** (`dataGroups`). Mais simples, mas guarda dado pessoal num cache por URL, sem saber de quem é, e ainda exigiria login para abrir as telas.
- **IndexedDB em vez de `localStorage`.** Seria o caminho para muitos dados; a carteira tem poucos quilobytes e é lida de uma vez, e o `localStorage` é síncrono e mais simples.
- **App nativo ou Wallet.** Resolvem o mesmo problema e dão mais (notificações, NFC, QR que muda), mas pedem lojas de apps, contas pagas e outra base de código. O PWA resolve o caso principal com o que já existe.

## Consequências

- Na primeira visita, o service worker baixa o app inteiro em segundo plano (cerca de 2 MB, sem as imagens). O cliente do service worker entra no pacote inicial, e o limite de aviso do pacote subiu de 600 kB para 650 kB.
- O código do QR fica no aparelho, como ficaria numa carteira ou num print. Quem tem o celular desbloqueado vê o ingresso; sair da conta o apaga.
- A carteira mostra o que era verdade na última atualização com internet. Um ingresso cancelado em outro aparelho continua aparecendo até a próxima atualização, mas a portaria o recusa (ela confere a lista dela).
- Uma versão nova da loja chega na próxima abertura depois de o service worker baixá-la. O nginx serve o `ngsw.json` e o `ngsw-worker.js` sem cache para isso funcionar.
- O teste ponta a ponta `ingresso-offline` compra, tira a rede do navegador e confere o QR na tela.
