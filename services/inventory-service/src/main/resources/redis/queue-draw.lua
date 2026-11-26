-- Sorteio da sala de espera, na abertura das vendas: as posições vêm embaralhadas de fora (Java,
-- com SecureRandom) e ficam à frente de qualquer chegada posterior, cujo score é a hora em ms.
-- Chegar 30 minutos antes não dá vantagem sobre quem chegou 1 minuto antes.
-- ARGV: 1 show, depois os usuários já na ordem sorteada.
-- Retorno: quantos entraram na fila, ou -1 se o sorteio já tinha sido feito.

local show = ARGV[1]
local drawn = 'queue:' .. show .. ':drawn'
if redis.call('EXISTS', drawn) == 1 then return -1 end
local queue = 'queue:' .. show
for i = 2, #ARGV do
  redis.call('ZADD', queue, 'NX', i - 1, ARGV[i])
end
redis.call('DEL', 'queue:' .. show .. ':room')
redis.call('SET', drawn, '1')
return #ARGV - 1
