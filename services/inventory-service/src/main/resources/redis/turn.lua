-- Virada de lote por data: o lote em venda esgota e o que sobrou dele passa para o próximo, ao
-- preço novo. Um setor pausado não vira sozinho.
-- ARGV: 1 show, 2 setor, 3 lote que deveria abrir agora.
-- Retorno: {'OK'} ou {'SKIP'} (o setor não está vendendo, ou o próximo lote já é outro).

local show, sector, expected = ARGV[1], ARGV[2], ARGV[3]
local sector_key = k_sector(show, sector)
if redis.call('HGET', sector_key, 'status') ~= 'ON_SALE' then return { 'SKIP' } end
local next_key = k_next(show, sector)
if redis.call('LINDEX', next_key, 0) ~= expected then return { 'SKIP' } end

local current = redis.call('HGET', sector_key, 'lot')
local leftover = tonumber(redis.call('GET', k_stock(current)) or '0')
redis.call('SET', k_stock(current), 0)
redis.call('LPOP', next_key)
redis.call('INCRBY', k_stock(expected), leftover)
redis.call('HSET', sector_key, 'lot', expected)

emit({ type = 'LOTS', lots = { lot_state(current, 'SOLD_OUT'), lot_state(expected, 'ON_SALE') } })
return { 'OK' }
