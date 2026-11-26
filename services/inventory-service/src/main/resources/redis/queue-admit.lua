-- Admite os próximos N da fila: cada um recebe um token de admissão com prazo. O N controla a
-- carga no checkout.
-- ARGV: 1 show, 2 quantos admitir, 3 validade do token (ms).
-- Retorno: lista plana {usuário, score, usuário, score...} dos admitidos.

local show, count, ttl = ARGV[1], tonumber(ARGV[2]), ARGV[3]
local popped = redis.call('ZPOPMIN', 'queue:' .. show, count)
for i = 1, #popped, 2 do
  redis.call('SET', 'admitted:' .. show .. ':' .. popped[i], '1', 'PX', ttl)
end
return popped
