-- Encerramento das vendas: o lote atual do setor fecha (em venda, pausado ou o último esgotado), e
-- nenhum ingresso devolvido depois volta à venda.
-- ARGV: 1 show, 2 setor.
-- Retorno: {'OK'} ou {'SKIP'} (já encerrado, ou nunca abriu).

local show, sector = ARGV[1], ARGV[2]
local sector_key = k_sector(show, sector)
local status = redis.call('HGET', sector_key, 'status')
if not status or status == 'CLOSED' or status == 'NOT_OPEN' then return { 'SKIP' } end

local current = redis.call('HGET', sector_key, 'lot')
redis.call('HSET', sector_key, 'status', 'CLOSED')
emit({ type = 'LOTS', lots = { lot_state(current, 'CLOSED') } })
return { 'OK' }
