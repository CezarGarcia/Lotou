-- HELD -> CONFIRMED: o pagamento foi aprovado e os ingressos estão vendidos.
-- ARGV: 1 id da reserva, 2 agora (ms).
-- Retorno: {'OK'}, {'ALREADY'}, {'NOT_HELD', status} ou {'NOT_FOUND'}.

local res, now = ARGV[1], tonumber(ARGV[2])
local key = k_res(res)
local r = hash_to_table(redis.call('HGETALL', key))
if not r.status then return { 'NOT_FOUND' } end
if r.status == 'CONFIRMED' then return { 'ALREADY' } end
if r.status ~= 'HELD' then return { 'NOT_HELD', r.status } end

r.status = 'CONFIRMED'
r.updatedAt = now
redis.call('HSET', key, 'status', r.status, 'updatedAt', now)
redis.call('PEXPIRE', key, FINISHED_RETENTION_MS)

-- As cadeiras continuam ocupadas: agora vendidas.
emit({ type = 'CONFIRMED', reservation = reservation_payload(res, r), seatStatus = 'SOLD' })
return { 'OK' }
