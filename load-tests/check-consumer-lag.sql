-- Os pedidos do show do último `make load-consumer-lag`, lidos do banco orders: os mesmos números
-- que o k6 comparou com o relatório do analytics (pedidos criados, confirmados, ingressos e total).
WITH show AS (
    SELECT id FROM shows WHERE title = 'Teste de carga: consumidor lento' ORDER BY id DESC LIMIT 1
)
SELECT o.status,
       count(*) AS pedidos,
       sum((SELECT count(*) FROM tickets t WHERE t.order_id = o.id)) AS ingressos,
       sum(o.total_cents) AS total_cents
FROM orders o JOIN show s ON s.id = o.show_id
GROUP BY o.status
ORDER BY o.status;
