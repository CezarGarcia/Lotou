-- Invariantes da portaria, conferidas no banco checkin depois do `make load-gate`. Variáveis do
-- psql: show (o show preparado) e since (o início da rodada, em UTC). As linhas de violação
-- devem mostrar zero.

-- 1. Nenhum ingresso com duas entradas. A constraint única de ticket_id já impede; a consulta
--    confere que nada passou por fora dela.
SELECT 'ingressos com mais de uma entrada' AS invariante, count(*) AS valor
FROM (SELECT ticket_id FROM checkins WHERE show_id = :'show' GROUP BY ticket_id HAVING count(*) > 1) AS twice
UNION ALL
-- 2. Ingresso usado sem entrada, ou entrada de ingresso que não está como usado.
SELECT 'ingressos usados sem entrada, ou entradas sem ingresso usado', count(*)
FROM valid_tickets t
FULL JOIN checkins c ON c.ticket_id = t.ticket_id
WHERE (t.show_id = :'show' OR c.show_id = :'show')
  AND ((t.status = 'USED') IS DISTINCT FROM (c.id IS NOT NULL))
UNION ALL
-- 3. Leitura barrada como "já utilizado" sem a entrada que a justifica.
SELECT 'recusas por já utilizado sem entrada anterior', count(*)
FROM checkin_rejections r
LEFT JOIN checkins c ON c.ticket_id = r.ticket_id
WHERE r.show_id = :'show' AND r.reason = 'ALREADY_USED' AND r.rejected_at >= :'since'
  AND c.id IS NULL;

-- O que a rodada registrou: entradas liberadas e leituras recusadas, por motivo, e as entradas por
-- portão. Liberadas = ingressos lidos; já utilizado = leituras repetidas.
SELECT 'liberadas' AS resultado, count(*) AS leituras
FROM checkins WHERE show_id = :'show' AND checked_in_at >= :'since'
UNION ALL
SELECT lower(reason), count(*)
FROM checkin_rejections WHERE show_id = :'show' AND rejected_at >= :'since'
GROUP BY reason;

SELECT gate AS portao, count(*) AS entradas
FROM checkins WHERE show_id = :'show' AND checked_in_at >= :'since'
GROUP BY gate ORDER BY gate;
