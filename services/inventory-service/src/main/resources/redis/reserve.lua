-- Reserva atômica: confere tudo e só então muda alguma coisa. Ou segura tudo, ou nada.
--
-- ARGV: 1 show, 2 setor, 3 id da reserva, 4 comprador, 5 hash do CPF, 6 quantidade,
--       7 máximo por CPF, 8 agora (ms), 9 duração da reserva (ms), 10 chave Redis de idempotência,
--       11 Idempotency-Key, 12 hash do pedido, 13 validade da idempotência (ms),
--       14 número de cadeiras (n), depois n IDs de cadeira, n posições no bitmap e n rótulos.
-- Retorno: {'OK', lote, expiraEm} ou {código do problema, detalhe}.

local show, sector, res, buyer, cpf = ARGV[1], ARGV[2], ARGV[3], ARGV[4], ARGV[5]
local qty, max_per_cpf = tonumber(ARGV[6]), tonumber(ARGV[7])
local now, ttl = tonumber(ARGV[8]), tonumber(ARGV[9])
local idem, idem_key, rhash, idem_ttl = ARGV[10], ARGV[11], ARGV[12], tonumber(ARGV[13])
local n = tonumber(ARGV[14])
local seat_ids, positions, labels = {}, {}, {}
for i = 1, n do
  seat_ids[i] = ARGV[14 + i]
  positions[i] = tonumber(ARGV[14 + n + i])
  labels[i] = ARGV[14 + 2 * n + i]
end

-- 1. Mesma Idempotency-Key: devolve a reserva já criada (ou recusa, se o pedido é outro).
local seen = redis.call('GET', idem)
if seen then
  local sep = string.find(seen, '|', 1, true)
  if string.sub(seen, sep + 1) == rhash then return { 'REPLAY', string.sub(seen, 1, sep - 1) } end
  return { 'IDEMPOTENCY_KEY_REUSED' }
end

-- 2. O estoque do show precisa estar carregado (as vendas abriram).
local show_key = k_show(show)
if redis.call('EXISTS', show_key) == 0 then return { 'NOT_LOADED' } end

-- 3. Show de alta demanda: só reserva quem a fila virtual admitiu.
if redis.call('HGET', show_key, 'highDemand') == '1'
    and redis.call('EXISTS', 'admitted:' .. show .. ':' .. buyer) == 0 then
  return { 'NOT_ADMITTED' }
end

-- 4. Limite de ingressos por CPF no show.
local limit_key = k_limit(show, cpf)
local used = tonumber(redis.call('GET', limit_key) or '0')
if used + qty > max_per_cpf then return { 'PURCHASE_LIMIT_EXCEEDED', tostring(math.max(0, max_per_cpf - used)) } end

-- 5. O setor está vendendo, e o lote em venda tem a quantidade pedida.
local sector_key = k_sector(show, sector)
local status = redis.call('HGET', sector_key, 'status')
if not status then return { 'SECTOR_NOT_FOUND' } end
if status ~= 'ON_SALE' then return { status } end
local lot = redis.call('HGET', sector_key, 'lot')
local stock = tonumber(redis.call('GET', k_stock(lot)) or '0')
if stock < qty then return { 'INSUFFICIENT_STOCK', tostring(stock) } end

-- 6. Cadeiras: todas livres, ou nenhuma é segurada.
local taken = {}
for i = 1, n do
  if redis.call('EXISTS', k_seat(show, seat_ids[i])) == 1 then table.insert(taken, labels[i]) end
end
if #taken > 0 then return { 'SEAT_UNAVAILABLE', table.concat(taken, ',') } end

-- Tudo conferido: segura.
local left = redis.call('DECRBY', k_stock(lot), qty)
local limit_now = redis.call('INCRBY', limit_key, qty)
local seatmap = k_seatmap(show, sector)
for i = 1, n do
  -- Sem TTL: a cadeira só é solta junto com o estoque e a cota, pela devolução (ADR 26).
  redis.call('SET', k_seat(show, seat_ids[i]), res)
  redis.call('SETBIT', seatmap, positions[i], 1)
end

local expires = now + ttl
local reservation = {
  status = 'HELD', buyer = buyer, show = show, sector = sector, cpf = cpf, qty = qty, lot = lot,
  seats = table.concat(seat_ids, ','), positions = table.concat(positions, ','),
  labels = table.concat(labels, ','), expiresAt = expires, createdAt = now, updatedAt = now,
  idemKey = idem_key, rhash = rhash
}
local fields = {}
for field, value in pairs(reservation) do
  table.insert(fields, field)
  table.insert(fields, value)
end
-- Sem TTL enquanto a reserva está ativa: quem a encerra é o job de expiração ou o pedido.
redis.call('HSET', k_res(res), unpack(fields))
redis.call('SET', idem, res .. '|' .. rhash, 'PX', idem_ttl)

-- Virada de lote: o contador zerou, o próximo lote do setor abre; sem próximo, o setor esgota.
local lots = { lot_state(lot, 'ON_SALE') }
if left == 0 then
  lots[1].status = 'SOLD_OUT'
  local next_lot = redis.call('LPOP', k_next(show, sector))
  if next_lot then
    redis.call('HSET', sector_key, 'lot', next_lot)
    table.insert(lots, lot_state(next_lot, 'ON_SALE'))
  else
    redis.call('HSET', sector_key, 'status', 'SOLD_OUT')
  end
end

emit({
  type = 'HELD', reservation = reservation_payload(res, reservation), lots = lots,
  seatStatus = 'HELD', limit = limit_now
})
publish_seats(show, sector, labels, false)
return { 'OK', lot, tostring(expires) }
