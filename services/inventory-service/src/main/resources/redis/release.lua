-- HELD -> RELEASED (pagamento recusado) ou HELD -> EXPIRED (prazo acabou): devolve à venda o que a
-- reserva segurava, de uma vez: estoque, cadeiras e cota do CPF.
--
-- ARGV: 1 id da reserva, 2 status final (RELEASED ou EXPIRED), 3 agora (ms),
--       4 '1' para só expirar se o prazo já passou.
-- Retorno: {'OK'}, {'ALREADY'}, {'NOT_DUE'}, {'NOT_HELD', status} ou {'NOT_FOUND'}.

local res, target, now, only_if_due = ARGV[1], ARGV[2], tonumber(ARGV[3]), ARGV[4] == '1'
local key = k_res(res)
local r = hash_to_table(redis.call('HGETALL', key))
if not r.status then return { 'NOT_FOUND' } end
if r.status == target then return { 'ALREADY' } end
if r.status ~= 'HELD' then return { 'NOT_HELD', r.status } end
if only_if_due and tonumber(r.expiresAt) > now then return { 'NOT_DUE' } end

r.status = target
r.updatedAt = now
redis.call('HSET', key, 'status', target, 'updatedAt', now)
redis.call('PEXPIRE', key, FINISHED_RETENTION_MS)

local entry = { type = target, reservation = reservation_payload(res, r) }
local freed_labels = give_back(res, r, entry)
emit(entry)
publish_seats(r.show, r.sector, freed_labels, true)
return { 'OK' }
