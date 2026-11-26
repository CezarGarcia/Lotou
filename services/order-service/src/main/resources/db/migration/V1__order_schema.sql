-- order-service: pedidos e ingressos.

CREATE TABLE orders (
    id               uuid PRIMARY KEY,
    -- Claim `sub` do comprador no Keycloak.
    buyer_id         text        NOT NULL,
    show_id          uuid        NOT NULL,
    -- Cada reserva vira no máximo um pedido.
    reservation_id   uuid        NOT NULL UNIQUE,
    status           text        NOT NULL CHECK (status IN
                         ('PENDING', 'CONFIRMED', 'CANCELLED', 'REFUNDING', 'REFUNDED', 'REFUND_FAILED')),
    -- Dinheiro em centavos, inteiro. O valor é o da reserva e não muda mais.
    total_cents      bigint      NOT NULL CHECK (total_cents >= 0),
    -- Resposta do pagamento, gravada antes do passo seguinte: retomar um pedido não cobra de novo.
    payment_status   text CHECK (payment_status IN ('AUTHORIZED', 'DECLINED')),
    cancel_reason    text CHECK (cancel_reason IN
                         ('PAYMENT_DECLINED', 'RESERVATION_EXPIRED', 'TICKET_CONFLICT')),
    idempotency_key  text        NOT NULL,
    -- Até quando alguém está processando o pedido. Vencido, o job de recuperação assume.
    processing_until timestamptz NOT NULL,
    created_at       timestamptz NOT NULL,
    updated_at       timestamptz NOT NULL,
    confirmed_at     timestamptz,
    -- Duas requisições com a mesma Idempotency-Key: só uma consegue inserir.
    UNIQUE (buyer_id, idempotency_key)
);

-- "Meus pedidos": do mais novo ao mais antigo (o UUID v7 já é ordenado por tempo).
CREATE INDEX orders_buyer_idx ON orders (buyer_id, id DESC);

-- O job de recuperação só olha os pedidos pendentes.
CREATE INDEX orders_pending_idx ON orders (processing_until) WHERE status = 'PENDING';

-- Um item por ingresso, com o preço congelado na reserva.
CREATE TABLE order_items (
    id               uuid PRIMARY KEY,
    order_id         uuid    NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
    position         integer NOT NULL,
    sector_id        uuid    NOT NULL,
    sector_name      text    NOT NULL,
    lot_id           uuid    NOT NULL,
    lot_name         text    NOT NULL,
    -- Rótulo da cadeira (A-12); nulo na pista.
    seat_label       text,
    unit_price_cents bigint  NOT NULL CHECK (unit_price_cents >= 0)
);

CREATE INDEX order_items_order_idx ON order_items (order_id);

CREATE TABLE tickets (
    id          uuid PRIMARY KEY,
    order_id    uuid        NOT NULL REFERENCES orders (id),
    position    integer     NOT NULL,
    show_id     uuid        NOT NULL,
    sector_id   uuid        NOT NULL,
    sector_name text        NOT NULL,
    seat_label  text,
    status      text        NOT NULL CHECK (status IN ('VALID', 'USED', 'CANCELLED')),
    issued_at   timestamptz NOT NULL
);

CREATE INDEX tickets_order_idx ON tickets (order_id);

-- Última defesa contra venda dupla (ADR 4): o banco recusa dois ingressos ativos para a mesma
-- cadeira do mesmo show, aconteça o que acontecer com a reserva. Ingresso cancelado libera a cadeira.
CREATE UNIQUE INDEX tickets_show_seat_uk ON tickets (show_id, sector_id, seat_label)
    WHERE seat_label IS NOT NULL AND status <> 'CANCELLED';
