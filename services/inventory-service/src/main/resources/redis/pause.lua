-- O produtor pausa ou retoma o lote em venda.
-- ARGV: 1 show, 2 setor, 3 lote, 4 ação ('PAUSE' ou 'RESUME').
-- Retorno: {'OK', status novo, ingressos restantes} ou {'INVALID', status atual do lote}.

local show, sector, lot, action = ARGV[1], ARGV[2], ARGV[3], ARGV[4]
local sector_key = k_sector(show, sector)
local status = redis.call('HGET', sector_key, 'status')
local current = redis.call('HGET', sector_key, 'lot')

-- O status do lote pedido, para a mensagem de erro seguir a tabela de transições.
local function lot_status()
  if lot == current then return LOT_STATUS[status] or 'SCHEDULED' end
  if redis.call('LPOS', k_next(show, sector), lot) then return 'SCHEDULED' end
  if status == 'CLOSED' then return 'CLOSED' end
  return 'SOLD_OUT'
end

local from, to = 'ON_SALE', 'PAUSED'
if action == 'RESUME' then from, to = 'PAUSED', 'ON_SALE' end
if lot ~= current or status ~= from then return { 'INVALID', lot_status() } end

redis.call('HSET', sector_key, 'status', to)
local state = lot_state(lot, to)
emit({ type = 'LOTS', lots = { state } })
return { 'OK', to, tostring(state.available) }
