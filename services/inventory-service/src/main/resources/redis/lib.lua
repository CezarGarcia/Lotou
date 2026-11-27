-- Funções comuns aos scripts do inventory. Cada script é este arquivo seguido do corpo dele.
--
-- Os nomes das chaves seguem a tabela "Redis" de docs/projeto.md. As chaves são montadas dentro
-- dos scripts, a partir dos IDs: funciona num Redis standalone, que é o que o projeto usa. Para ir
-- a um Redis Cluster, as chaves de um show precisariam de hash tag ({showId}).

local function k_show(show) return 'show:' .. show end
local function k_sector(show, sector) return 'sector:' .. show .. ':' .. sector end
local function k_next(show, sector) return 'sector:' .. show .. ':' .. sector .. ':next' end
local function k_stock(lot) return 'lot:' .. lot .. ':stock' end
local function k_seat(show, seat) return 'seat:' .. show .. ':' .. seat end
local function k_seatmap(show, sector) return 'seatmap:' .. show .. ':' .. sector end
local function k_res(res) return 'res:' .. res end
local function k_limit(show, cpf) return 'limit:' .. show .. ':' .. cpf end

local STREAM = 'stream:reservations'
-- Uma reserva concluída fica no Redis por um dia, para repetições e consultas; depois, só no Postgres.
local FINISHED_RETENTION_MS = 86400000

-- O status do lote atual do setor, a partir do status do setor.
local LOT_STATUS = { ON_SALE = 'ON_SALE', PAUSED = 'PAUSED', SOLD_OUT = 'SOLD_OUT', CLOSED = 'CLOSED' }

local function split(csv)
  local items = {}
  if csv and csv ~= '' then
    for item in string.gmatch(csv, '[^,]+') do table.insert(items, item) end
  end
  return items
end

local function hash_to_table(flat)
  local result = {}
  for i = 1, #flat, 2 do result[flat[i]] = flat[i + 1] end
  return result
end

-- O estado de um lote como o Postgres grava: ingressos restantes e status (valores absolutos).
local function lot_state(lot, status)
  return { id = lot, available = tonumber(redis.call('GET', k_stock(lot)) or '0'), status = status }
end

-- Os dados da reserva que vão para o Postgres em toda entrada do stream. Cada entrada leva a
-- reserva inteira: o consumidor grava mesmo que as entradas cheguem fora de ordem.
local function reservation_payload(id, r)
  return {
    id = id, status = r.status, buyer = r.buyer, show = r.show, sector = r.sector, cpf = r.cpf,
    qty = tonumber(r.qty), lot = r.lot, seats = r.seats, expiresAt = tonumber(r.expiresAt),
    createdAt = tonumber(r.createdAt), updatedAt = tonumber(r.updatedAt),
    idempotencyKey = r.idemKey, requestHash = r.rhash
  }
end

-- Registra a mudança no stream, na mesma operação atômica que a fez. Campos vazios ficam de fora.
local function emit(entry)
  return redis.call('XADD', STREAM, '*', 'data', cjson.encode(entry))
end

-- Avisa quem está com o mapa do setor aberto (pub/sub: perder uma mensagem se corrige na próxima
-- leitura do bitmap).
local function publish_seats(show, sector, labels, available)
  if #labels > 0 then
    redis.call('PUBLISH', 'seatmap.' .. show,
      cjson.encode({ sectorId = sector, seats = labels, available = available }))
  end
end

-- Devolve à venda o que a reserva tinha, segurado ou vendido, de uma vez: cota do CPF, cadeiras e
-- estoque. É o mesmo caminho para a reserva liberada, a expirada e a devolvida depois do
-- reembolso. Preenche na entrada do stream o estado final do que mudou e devolve os rótulos das
-- cadeiras soltas, para o aviso do mapa.
local function give_back(res, r, entry)
  local show, sector, qty = r.show, r.sector, tonumber(r.qty)

  -- Cota do CPF.
  local limit_key = k_limit(show, r.cpf)
  local limit_now = redis.call('DECRBY', limit_key, qty)
  if limit_now < 0 then
    redis.call('SET', limit_key, 0, 'KEEPTTL')
    limit_now = 0
  end
  entry.limit = limit_now

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
  if #freed > 0 then
    entry.seats = table.concat(freed, ',')
    entry.seatStatus = 'AVAILABLE'
  end

  -- Estoque: volta para o lote em venda, ao preço dele. Se o setor esgotou, o último lote reabre
  -- (ADR 25). Depois do encerramento das vendas, não há para onde devolver.
  local sector_key = k_sector(show, sector)
  local sector_status = redis.call('HGET', sector_key, 'status')
  if sector_status and sector_status ~= 'CLOSED' and sector_status ~= 'NOT_OPEN' then
    local current = redis.call('HGET', sector_key, 'lot')
    redis.call('INCRBY', k_stock(current), qty)
    if sector_status == 'SOLD_OUT' then
      sector_status = 'ON_SALE'
      redis.call('HSET', sector_key, 'status', sector_status)
    end
    entry.lots = { lot_state(current, LOT_STATUS[sector_status]) }
  end
  return freed_labels
end
