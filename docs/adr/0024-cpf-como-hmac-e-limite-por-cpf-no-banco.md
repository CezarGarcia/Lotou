# 0024. CPF gravado como HMAC e limite por CPF conferido no banco

- **Status:** aceita
- **Data:** 2026-11-26

## Contexto

A regra de negócio limita a 4 ingressos por CPF em cada show, somando todos os pedidos. Para aplicá-la, o inventory precisa reconhecer o mesmo CPF entre reservas. Ao mesmo tempo, a convenção de LGPD do projeto diz que o CPF não aparece em logs, traces nem chaves do Redis, e que se usa um hash dele.

Duas perguntas precisavam de resposta:

1. **Que hash?** Existem só 10^11 CPFs possíveis (menos ainda, por causa dos dígitos verificadores). Um SHA-256 puro de todos eles se calcula em minutos, então quem lesse a tabela recuperaria os CPFs. Um hash sem segredo não protege um dado com tão poucos valores.
2. **Como conferir o limite sob concorrência?** Duas reservas simultâneas do mesmo CPF podem ler "3 ingressos" e as duas somarem 1.

## Decisão

**O CPF vira um HMAC-SHA-256 com chave secreta** (`CPF_HASH_KEY`), e é só isso que o inventory grava.

- O comprador informa o CPF ao reservar. O serviço valida os dígitos verificadores, calcula o HMAC e descarta o CPF.
- O HMAC é determinístico, então o mesmo CPF sempre cai na mesma linha. Sem a chave, não dá para testar CPFs contra a tabela.
- O objeto da requisição se descreve sem o CPF (`toString`), para ele não vazar num log por acidente. O Collector mascara qualquer valor com formato de CPF como segunda barreira.

**O limite é conferido e incrementado num único comando**, na tabela `purchase_limits`:

```sql
INSERT INTO purchase_limits AS pl (show_id, cpf_hash, quantity) VALUES (:show, :hash, :n)
ON CONFLICT (show_id, cpf_hash) DO UPDATE
SET quantity = pl.quantity + EXCLUDED.quantity
WHERE pl.quantity + EXCLUDED.quantity <= 4
```

Se nenhuma linha é afetada, a reserva passaria do limite e é recusada. O comando trava a linha do CPF até o fim da transação, então duas reservas do mesmo CPF passam uma de cada vez. Reserva expirada, liberada ou (na fase 6) reembolsada devolve a cota.

## Consequências

- O limite vale de verdade sob disputa: no teste, 30 reservas simultâneas do mesmo CPF resultam em exatamente 4.
- O limite é por CPF, não por conta: outra conta com o mesmo CPF também é barrada.
- A chave do HMAC passa a ser um segredo do inventory. Trocar a chave muda todos os hashes e zera os limites em andamento, então a troca só pode acontecer entre shows, ou guardando a chave antiga para os shows abertos.
- O CPF informado não é verificado contra a identidade do comprador (isso exigiria cadastro com CPF validado). Quem informa um CPF alheio válido passa. Para um projeto de portfólio é aceito; num produto real o CPF viria do cadastro.
- Na fase 2 a chave `limit:{showId}:{cpfHash}` do Redis usa o mesmo hash.
