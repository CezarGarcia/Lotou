# 0025. Devolução de ingresso reabre o último lote; reserva sai de um lote só

- **Status:** aceita
- **Data:** 2026-11-26

## Contexto

As regras de lote dizem que o próximo lote abre quando o atual esgota, e que ingressos devolvidos (reserva expirada, pagamento recusado ou reembolso) voltam para o lote em venda, nunca para um lote mais barato já encerrado.

Ao implementar, três situações não estavam cobertas:

1. **Devolução sem lote em venda.** O contador zera pelas reservas, não pelas vendas pagas. Numa abertura de vendas, o último lote esgota em segundos, e parte dessas reservas expira ou tem o pagamento recusado. A tabela de estados dizia que `SOLD_OUT` era final, então esses ingressos não teriam para onde voltar e ficariam fora de venda para sempre.
2. **Pedido maior que o resto do lote.** O lote tem 1 ingresso e o comprador quer 2.
3. **Virada por data com ingressos sobrando.** Chega a data do segundo lote e o primeiro ainda tem estoque.

## Decisão

1. **A devolução reabre o último lote esgotado.** Se o setor não tem lote em venda, o lote esgotado de maior ordem volta a `ON_SALE` com os ingressos devolvidos. A tabela de transições do lote ganha `SOLD_OUT → ON_SALE`, usada só nesse caso. A regra "nunca reabrir um lote mais barato" continua valendo: o que reabre é sempre o mais recente.
2. **Uma reserva sai de um lote só.** Se o lote em venda tem menos ingressos que o pedido, a reserva é recusada com `insufficient-stock`, e o erro informa quantos restam. O comprador pode levar o que resta ao preço atual; o lote seguinte só abre quando o atual zera.
3. **Na virada por data, o que sobrou passa para o lote novo.** O lote anterior zera e vai para `SOLD_OUT`; o próximo abre com a própria quantidade mais a sobra, ao preço novo. Um lote pausado pelo produtor não vira sozinho.

Depois que as vendas do show encerram, devoluções não voltam a lugar nenhum: não há mais venda.

As três regras estão em `SectorLots`, que não acessa o banco e é coberta por testes de unidade.

## Consequências

- Nenhum ingresso se perde entre a reserva e a venda: o que foi reservado mais o que resta nos contadores é sempre a capacidade à venda, e os testes de concorrência conferem essa conta.
- `SOLD_OUT` deixa de ser um estado final. `docs/projeto.md` foi atualizado: diagrama, tabela de transições e regras de lote.
- Um setor pode alternar entre "esgotado" e "à venda" várias vezes numa abertura, conforme as reservas expiram. Para o comprador isso é o esperado ("voltou um ingresso"); para o painel do produtor, o evento `LotSoldOut` da fase 3 pode acontecer mais de uma vez no mesmo lote.
- Com a reserva num lote só, o preço de uma reserva é sempre um só, o que simplifica o pedido e o reembolso. O custo é o comprador que queria 2 ingressos e encontra 1: ele vê a mensagem e decide.
- A regra do item 2 pode travar a virada por um ingresso "que ninguém quer sozinho". Se isso aparecer nos testes de carga, a alternativa é dividir a reserva entre dois lotes, com dois preços.
