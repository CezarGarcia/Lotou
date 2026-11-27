-- CONFIRMED -> RETURNED: o pedido foi cancelado e reembolsado, e os ingressos vendidos voltam à
-- venda (comando ReturnTickets). Devolve de uma vez, pelas mesmas regras da liberação: estoque para
-- o lote em venda do setor (o último lote reabre se o setor esgotou, ADR 25), cadeiras e bitmap,
-- cota do CPF.
--
-- Com as vendas encerradas, os ingressos não voltam à venda (não há lote para recebê-los), mas a
-- reserva passa a RETURNED, as cadeiras ficam livres e a cota do CPF é devolvida do mesmo jeito.
--
-- A reserva confirmada fica no Redis só por um dia depois de concluída; o cancelamento pode chegar
-- depois disso. Nesse caso o hash não existe mais e o chamador manda a reserva lida do Postgres
-- (ARGV 3 em diante). O hash, se existir, sempre vale mais que essa cópia.
--
-- ARGV: 1 id da reserva, 2 agora (ms); opcionalmente, a reserva do Postgres: 3 status,
--       4 comprador, 5 show, 6 setor, 7 hash do CPF, 8 quantidade, 9 lote, 10 IDs das cadeiras,
--       11 posições no bitmap, 12 rótulos, 13 expiraEm, 14 criadaEm, 15 atualizadaEm,
--       16 Idempotency-Key, 17 hash do pedido.
-- Retorno: {'OK'}, {'ALREADY'}, {'NOT_CONFIRMED', status}, {'NOT_LOADED'} ou {'NOT_FOUND'}.

local res, now = ARGV[1], tonumber(ARGV[2])
local key = k_res(res)
local r = hash_to_table(redis.call('HGETALL', key))
local from_postgres = false
if not r.status then
  if #ARGV < 17 then return { 'NOT_FOUND' } end
  r = {
    status = ARGV[3], buyer = ARGV[4], show = ARGV[5], sector = ARGV[6], cpf = ARGV[7], qty = ARGV[8],
    lot = ARGV[9], seats = ARGV[10], positions = ARGV[11], labels = ARGV[12], expiresAt = ARGV[13],
    createdAt = ARGV[14], updatedAt = ARGV[15], idemKey = ARGV[16], rhash = ARGV[17]
  }
  from_postgres = true
end
if r.status == 'RETURNED' then return { 'ALREADY' } end
if r.status ~= 'CONFIRMED' then return { 'NOT_CONFIRMED', r.status } end
-- Sem a marca do show, o Redis não tem o estado da venda para receber a devolução.
if redis.call('EXISTS', k_show(r.show)) == 0 then return { 'NOT_LOADED' } end

r.status = 'RETURNED'
r.updatedAt = now
if from_postgres then
  local fields = {}
  for field, value in pairs(r) do
    table.insert(fields, field)
    table.insert(fields, value)
  end
  redis.call('HSET', key, unpack(fields))
else
  redis.call('HSET', key, 'status', r.status, 'updatedAt', now)
end
-- Fica um dia, como as outras reservas concluídas: um ReturnTickets repetido acha RETURNED aqui.
redis.call('PEXPIRE', key, FINISHED_RETENTION_MS)

local entry = { type = 'RETURNED', reservation = reservation_payload(res, r) }
local freed_labels = give_back(res, r, entry)
emit(entry)
publish_seats(r.show, r.sector, freed_labels, true)
return { 'OK' }
