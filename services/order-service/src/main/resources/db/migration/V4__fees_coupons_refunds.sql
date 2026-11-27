-- Fase 6: taxa de serviço, cupons, reembolso e a cópia local do catálogo.

-- Cópia local do que o order-service precisa de cada show, lida de shows.catalog: quem paga a
-- taxa, a data (prazo de cancelamento), o produtor (dono dos cupons) e o status (show cancelado
-- dispara o reembolso de todos os pedidos).
CREATE TABLE shows (
    id                  uuid PRIMARY KEY,
    producer_id         text        NOT NULL,
    status              text        NOT NULL,
    title               text        NOT NULL,
    starts_at           timestamptz NOT NULL,
    service_fee_paid_by text        NOT NULL CHECK (service_fee_paid_by IN ('BUYER', 'PRODUCER')),
    version             integer     NOT NULL,
    updated_at          timestamptz NOT NULL
);

-- Valores do pedido. O total é o que foi cobrado: subtotal - desconto + taxa (se o comprador paga).
ALTER TABLE orders
    ADD COLUMN subtotal_cents      bigint CHECK (subtotal_cents >= 0),
    ADD COLUMN discount_cents      bigint NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
    ADD COLUMN service_fee_cents   bigint NOT NULL DEFAULT 0 CHECK (service_fee_cents >= 0),
    ADD COLUMN service_fee_paid_by text   NOT NULL DEFAULT 'BUYER' CHECK (service_fee_paid_by IN ('BUYER', 'PRODUCER')),
    ADD COLUMN coupon_id           uuid,
    ADD COLUMN coupon_code         text,
    ADD COLUMN refunded_cents      bigint CHECK (refunded_cents >= 0),
    ADD COLUMN refunded_at         timestamptz;
UPDATE orders SET subtotal_cents = total_cents WHERE subtotal_cents IS NULL;
ALTER TABLE orders ALTER COLUMN subtotal_cents SET NOT NULL;

CREATE INDEX orders_show_status_idx ON orders (show_id, status);

-- Ingresso usado na portaria: quando e onde.
ALTER TABLE tickets
    ADD COLUMN used_at timestamptz,
    ADD COLUMN gate    text;

-- Cupons do produtor. O uso é contado aqui, na transação do pedido (ADR 33).
CREATE TABLE coupons (
    id           uuid PRIMARY KEY,
    show_id      uuid        NOT NULL,
    code         text        NOT NULL,
    kind         text        NOT NULL CHECK (kind IN ('PERCENT', 'AMOUNT')),
    percent      integer CHECK (percent BETWEEN 1 AND 100),
    amount_cents bigint CHECK (amount_cents > 0),
    max_uses     integer     NOT NULL CHECK (max_uses > 0),
    uses         integer     NOT NULL DEFAULT 0,
    status       text        NOT NULL CHECK (status IN ('ACTIVE', 'PAUSED')),
    valid_until  timestamptz NOT NULL,
    sector_ids   uuid[]      NOT NULL DEFAULT '{}',
    idempotency_key text     NOT NULL,
    created_by   text        NOT NULL,
    created_at   timestamptz NOT NULL,
    updated_at   timestamptz NOT NULL,
    -- O limite nunca é ultrapassado, nem por uma corrida.
    CHECK (uses BETWEEN 0 AND max_uses),
    CHECK ((kind = 'PERCENT') = (percent IS NOT NULL) AND (kind = 'AMOUNT') = (amount_cents IS NOT NULL)),
    UNIQUE (show_id, code),
    UNIQUE (created_by, idempotency_key)
);

-- Um uso por pedido. A devolução marca returned_at, e é idempotente.
CREATE TABLE coupon_redemptions (
    order_id       uuid PRIMARY KEY REFERENCES orders (id),
    coupon_id      uuid        NOT NULL REFERENCES coupons (id),
    discount_cents bigint      NOT NULL CHECK (discount_cents >= 0),
    redeemed_at    timestamptz NOT NULL,
    returned_at    timestamptz
);

CREATE INDEX coupon_redemptions_coupon_idx ON coupon_redemptions (coupon_id);

-- Pedido de reembolso, com o passo da saga de reembolso (o estorno) e as tentativas.
--   QUEUED: show cancelado, esperando a vez (controle de vazão);
--   REFUNDING: RefundPayment enviado, esperando PaymentRefunded;
--   COMPLETED: estornado; FAILED: 5 falhas, tratamento manual.
CREATE TABLE refunds (
    order_id     uuid PRIMARY KEY REFERENCES orders (id),
    reason       text        NOT NULL CHECK (reason IN ('ORDER_CANCELLED', 'SHOW_CANCELLED')),
    status       text        NOT NULL CHECK (status IN ('QUEUED', 'REFUNDING', 'COMPLETED', 'FAILED')),
    amount_cents bigint      NOT NULL CHECK (amount_cents >= 0),
    failures     integer     NOT NULL DEFAULT 0,
    deadline     timestamptz,
    requested_at timestamptz NOT NULL,
    updated_at   timestamptz NOT NULL,
    completed_at timestamptz
);

CREATE INDEX refunds_queued_idx ON refunds (requested_at) WHERE status = 'QUEUED';
CREATE INDEX refunds_deadline_idx ON refunds (deadline) WHERE status = 'REFUNDING';
