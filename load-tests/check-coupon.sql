-- Invariantes do cupom, conferidas no banco orders depois do `make load-coupon`, no cupom mais
-- recente do teste (código CARGA...). As linhas de violação devem mostrar zero.
WITH coupon AS (
    SELECT * FROM coupons WHERE code LIKE 'CARGA%' ORDER BY created_at DESC LIMIT 1
),
redeemed AS (
    SELECT count(*) AS total FROM coupon_redemptions r JOIN coupon c ON c.id = r.coupon_id
    WHERE r.returned_at IS NULL
),
with_coupon AS (
    SELECT count(*) AS total FROM orders o JOIN coupon c ON c.id = o.coupon_id
    WHERE o.status NOT IN ('CANCELLED', 'REFUNDED')
)
-- 1. O contador nunca passa do limite.
SELECT 'usos além do limite' AS invariante, greatest(c.uses - c.max_uses, 0) AS valor FROM coupon c
UNION ALL
-- 2. O contador bate com os usos registrados, pedido a pedido.
SELECT 'contador diferente dos usos registrados', abs(c.uses - r.total) FROM coupon c, redeemed r
UNION ALL
-- 3. Cada uso é de um pedido que existe e leva o cupom.
SELECT 'pedidos com o cupom diferente dos usos', abs(o.total - r.total) FROM with_coupon o, redeemed r;

SELECT c.code AS cupom, c.uses AS usos, c.max_uses AS limite,
       (SELECT count(*) FROM orders o WHERE o.coupon_id = c.id) AS pedidos_com_o_cupom,
       (SELECT count(*) FROM orders o WHERE o.coupon_id = c.id AND o.status = 'CONFIRMED') AS confirmados
FROM coupons c WHERE code LIKE 'CARGA%' ORDER BY created_at DESC LIMIT 1;
