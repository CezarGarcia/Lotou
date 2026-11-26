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

local show, sector, qty = r.show, r.sector, tonumber(r.qty)
r.status = target
r.updatedAt = now
redis.call('HSET', key, 'status', target, 'updatedAt', now)
redis.call('PEXPIRE', key, FINISHED_RETENTION_MS)

-- Cota do CPF.
local limit_key = k_limit(show, r.cpf)
local limit_now = redis.call('DECRBY', limit_key, qty)
if limit_now < 0 then
  redis.call('SET', limit_key, 0, 'KEEPTTL')
  limit_now = 0
end

-- Cadeiras: só solta as que ainda são desta reserva.
local seat_ids, positions, labels = split(r.seats), split(r.positions), split(r.labels)
local freed, freed_labels = {}, {}
local seatmap = k_seatmap(show, sector)
for i = 1, #seat_ids do
  local seat_key = k_seat(show, seat_ids[i])
  if redis.call('GET', seat_key) == res then
    redis.call('DEL', seat_key)
    redis.call('SETBIT', seatmap, tonumber(positions[i]), 0)
    table.insert(freed, seat_ids[i])
    table.insert(freed_labels, labels[i])
  end
end

-- Estoque: volta para o lote em venda, ao preço dele. Se o setor esgotou, o último lote reabre
-- (ADR 25). Depois do encerramento das vendas, não há para onde devolver.
local sector_key = k_sector(show, sector)
local sector_status = redis.call('HGET', sector_key, 'status')
local lots = {}
if sector_status and sector_status ~= 'CLOSED' and sector_status ~= 'NOT_OPEN' then
  local current = redis.call('HGET', sector_key, 'lot')
  redis.call('INCRBY', k_stock(current), qty)
  if sector_status == 'SOLD_OUT' then
    sector_status = 'ON_SALE'
    redis.call('HSET', sector_key, 'status', sector_status)
  end
  lots = { lot_state(current, LOT_STATUS[sector_status]) }
end

local entry = { type = target, reservation = reservation_payload(res, r), limit = limit_now }
if #lots > 0 then entry.lots = lots end
if #freed > 0 then
  entry.seats = table.concat(freed, ',')
  entry.seatStatus = 'AVAILABLE'
end
emit(entry)
publish_seats(show, sector, freed_labels, true)
return { 'OK' }
