# 0038. Portaria sem internet: QR assinado com Ed25519, lista no aparelho e conflitos conciliados depois

- **Status:** aceita
- **Data:** 2026-11-27

## Contexto

O leitor da portaria mandava cada QR ao checkin-service e esperava a resposta. Se a internet do local caísse (estádio lotado satura a antena), a portaria parava. O QR era assinado com HMAC (ADR 15): para conferir a assinatura no aparelho, ele precisaria da chave, e com ela daria para *criar* ingressos falsos.

A pesquisa sobre as plataformas de ingressos mostrou o mesmo padrão em quase todas (Ticketmaster, Eventbrite, Sympla, Ingresse, Tixr): o leitor valida contra uma lista baixada antes e envia as leituras quando a conexão volta. Todas assumem que, com aparelhos sem rede, o mesmo QR pode passar em dois deles; as mitigações são de operação (um portão por setor, sincronizar sempre que houver rede), e o servidor registra o conflito em vez de recusar o que já aconteceu. A Ticketmaster usa QR que muda (SafeTix) contra o print repassado, com o segredo guardado no celular do comprador.

A entrada dupla é o problema que importa: o mesmo QR entrando duas vezes é uma pessoa sem ingresso dentro do show (o print repassado, ou o golpe de vender o mesmo ingresso verdadeiro para várias pessoas).

## Decisão

- **QR assinado com Ed25519** (`LOTOU2.<ticketId>.<assinatura>`): o order-service assina com a chave privada; a portaria confere com a pública, no servidor e no aparelho. Quem tem a chave pública não consegue criar ingresso, como nos bilhetes de trem europeus (UIC 918.3). O formato `LOTOU1` (HMAC) continua aceito online, para os ingressos já emitidos; offline, ele vale só se o ingresso estiver na lista do aparelho.
- **Online continua sendo o padrão.** O leitor só valida no aparelho quando o servidor não responde em 4 s (ou responde 502, 503 ou 504), e avisa na tela que está sem internet.
- **Pacote offline por show** (`GET /checkins/shows/{showId}/offline-package`): todos os ingressos do show com setor e situação (válido, usado com portão e horário, cancelado), a chave pública e a regra de abertura dos portões. O leitor baixa ao abrir o show e a cada 2 minutos com internet, e guarda no IndexedDB. Não tem dado pessoal.
- **Leituras offline guardadas no aparelho e enviadas quando a rede volta** (`POST /checkins/offline`, idempotente pelo id de cada leitura). No servidor, a primeira entrada pelo horário da leitura vale e vira um check-in normal, com o `TicketCheckedIn` de sempre; as outras viram um **conflito registrado** (`offline_conflicts`: entrada dupla, ingresso cancelado ou desconhecido), com métrica e alerta no Grafana. O ingresso já entrou: recusar depois não adianta, mas o produtor e a operação ficam sabendo, com portão, aparelho e horário.
- **Cada portão pode atender só alguns setores**, escolhidos na configuração do leitor. Offline, o leitor recusa ingresso de outro setor. Com isso, um print repassado só passa duas vezes em aparelhos do mesmo portão, os dois sem rede ao mesmo tempo.
- **QR que muda fica para depois.** Ele resolve o print, mas exige um segredo no celular do comprador, o que conflita com o ingresso que abre sem internet (ADR 37) e pode ser extraído do aparelho, como já foi feito com o SafeTix.

## Alternativas consideradas

- **Manter o HMAC e mandar a chave ao aparelho.** Qualquer celular da portaria perdido ou inspecionado viraria uma fábrica de ingressos.
- **Portaria só online.** Mais simples, e a garantia de entrada única fica sempre no servidor, mas a portaria para justamente quando o local enche.
- **Recusar a sincronização de uma leitura em conflito.** A pessoa já está dentro; recusar só apagaria o registro do problema.
- **Sincronização direta entre os aparelhos (rede local).** Diminuiria a janela da entrada dupla, mas é bem mais complexa; a divisão por setores resolve a maior parte do risco.

## Consequências

- A portaria continua funcionando sem internet. O pior caso (rede do local caída e dois aparelhos do mesmo portão) deixa passar um print repassado, e o sistema mostra isso depois, com o alerta "Entrada indevida pela portaria offline".
- O order-service guarda uma chave privada (`TICKET_SIGNING_KEY`) e o checkin-service, a pública (`TICKET_PUBLIC_KEY`). Trocar a chave exige um prefixo novo ou uma lista de chaves públicas válidas; os QRs antigos continuam valendo enquanto a chave deles for aceita.
- O QR ficou maior (130 caracteres em vez de 87), ainda bem dentro do que um QR lê com folga.
- A lista no aparelho pode estar alguns minutos atrasada: um ingresso cancelado depois do último download passa offline e vira um conflito `CANCELLED` na sincronização.
- O teste de carga da portaria continua gerando QRs `LOTOU1` (o k6 não tem Ed25519), que a portaria aceita online.
