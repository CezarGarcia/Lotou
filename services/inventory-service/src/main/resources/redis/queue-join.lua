-- Entrada na fila virtual de um show de alta demanda.
--
-- Antes da abertura das vendas, a pessoa entra na sala de espera (um conjunto, sem ordem). Na
-- abertura, a sala é sorteada (queue-draw.lua) e ganha as primeiras posições. Quem chega depois
-- entra no fim da fila, com a hora de chegada como score: sempre atrás de quem estava na sala.
--
-- ARGV: 1 show, 2 usuário, 3 agora (ms), 4 abertura das vendas (ms).
-- Retorno: {'ADMITTED', ms restantes} | {'WAITING_ROOM'} | {'QUEUED', posição (1 = a próxima)}.

local show, user, now, sales_start = ARGV[1], ARGV[2], tonumber(ARGV[3]), tonumber(ARGV[4])
local admitted = 'admitted:' .. show .. ':' .. user
local ttl = redis.call('PTTL', admitted)
if ttl > 0 then return { 'ADMITTED', tostring(ttl) } end

local queue, room = 'queue:' .. show, 'queue:' .. show .. ':room'
if redis.call('ZSCORE', queue, user) then
  return { 'QUEUED', tostring(redis.call('ZRANK', queue, user) + 1) }
end
if redis.call('EXISTS', 'queue:' .. show .. ':drawn') == 0 and now < sales_start then
  redis.call('SADD', room, user)
  return { 'WAITING_ROOM' }
end
if redis.call('SISMEMBER', room, user) == 1 then return { 'WAITING_ROOM' } end
redis.call('ZADD', queue, 'NX', now, user)
return { 'QUEUED', tostring(redis.call('ZRANK', queue, user) + 1) }
