-- Invariantes do inventory, conferidas no Postgres depois de um teste de carga. Todas as linhas
-- devem mostrar zero. Rode com: make load-check
--
-- No motor Redis, o Postgres recebe as reservas pelo stream: espere alguns segundos depois do
-- teste antes de conferir.

-- 1. Nenhum lote com mais ingressos reservados (ativos ou vendidos) do que a quantidade dele.
SELECT 'lotes vendidos além da quantidade' AS invariante, count(*) AS violacoes
FROM (
    SELECT l.id
    FROM lots l
    JOIN reservation_items i ON i.lot_id = l.id
    JOIN reservations r ON r.id = i.reservation_id AND r.status IN ('HELD', 'CONFIRMED')
    GROUP BY l.id, l.quantity
    HAVING count(*) > l.quantity
) AS oversold
UNION ALL
-- 2. Nenhum setor com mais ingressos que a capacidade.
SELECT 'setores vendidos além da capacidade', count(*)
FROM (
    SELECT s.show_id, s.id
    FROM sectors s
    JOIN reservations r ON r.show_id = s.show_id AND r.sector_id = s.id AND r.status IN ('HELD', 'CONFIRMED')
    GROUP BY s.show_id, s.id, s.capacity
    HAVING sum(r.quantity) > s.capacity
) AS over_capacity
UNION ALL
-- 3. Nenhuma cadeira em duas reservas ativas.
SELECT 'cadeiras em duas reservas ativas', count(*)
FROM (
    SELECT i.seat_id
    FROM reservation_items i
    JOIN reservations r ON r.id = i.reservation_id AND r.status IN ('HELD', 'CONFIRMED')
    WHERE i.seat_id IS NOT NULL
    GROUP BY i.seat_id
    HAVING count(*) > 1
) AS double_booked
UNION ALL
-- 4. Os contadores batem com as reservas, por setor: tudo o que foi posto à venda (lotes já
--    abertos) é o que resta nos contadores mais o que está reservado ou vendido. A virada de lote
--    e a devolução movem ingressos entre lotes do setor, mas não mudam a soma. Setores encerrados
--    ficam de fora: depois do encerramento, uma devolução não volta ao contador.
SELECT 'setores com contador inconsistente', count(*)
FROM (
    SELECT l.show_id, l.sector_id
    FROM lots l
    WHERE l.status <> 'SCHEDULED'
    GROUP BY l.show_id, l.sector_id
    HAVING bool_and(l.status <> 'CLOSED')
       AND sum(l.quantity) <> sum(l.available) + (
           SELECT coalesce(sum(r.quantity), 0) FROM reservations r
           WHERE r.show_id = l.show_id AND r.sector_id = l.sector_id AND r.status IN ('HELD', 'CONFIRMED'))
) AS inconsistent;
