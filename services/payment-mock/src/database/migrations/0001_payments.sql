-- Pagamentos simulados: uma linha por pedido. A linha guarda a decisão, para
-- que um comando repetido receba a mesma resposta e nunca uma segunda cobrança.
CREATE TABLE payments (
  id                    uuid        PRIMARY KEY,
  order_id              uuid        NOT NULL UNIQUE,
  buyer_id              text,
  status                text        NOT NULL
    CHECK (status IN ('AUTHORIZED', 'DECLINED', 'REFUNDED', 'VOIDED')),
  amount_cents          bigint      NOT NULL CHECK (amount_cents >= 0),
  decline_reason        text
    CHECK (decline_reason IN ('INSUFFICIENT_FUNDS', 'CARD_DECLINED', 'FRAUD_SUSPECTED')),
  refunded_amount_cents bigint      NOT NULL DEFAULT 0
    CHECK (refunded_amount_cents BETWEEN 0 AND amount_cents),
  -- Estornos tentados, com sucesso ou não; vai no RefundFailed como `attempt`.
  refund_attempts       integer     NOT NULL DEFAULT 0 CHECK (refund_attempts >= 0),
  -- Quando o gateway aprovou ou recusou (ou quando o pedido foi anulado).
  decided_at            timestamptz NOT NULL,
  refunded_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payments_reason_only_when_declined
    CHECK ((status = 'DECLINED') = (decline_reason IS NOT NULL)),
  CONSTRAINT payments_refunded_at_when_closed
    CHECK ((status IN ('REFUNDED', 'VOIDED')) = (refunded_at IS NOT NULL))
);

-- Comandos já processados: o efeito e o `eventId` entram na mesma transação,
-- então uma mensagem entregue de novo é reconhecida e ignorada.
CREATE TABLE processed_events (
  event_id     uuid        PRIMARY KEY,
  type         text        NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now()
);

-- Respostas a publicar no Kafka, gravadas na mesma transação do pagamento.
-- `seq` dá a ordem de publicação; `id` é o `eventId` da mensagem, que não muda
-- se o relay precisar publicar de novo.
CREATE TABLE outbox (
  id           uuid        PRIMARY KEY,
  seq          bigint      GENERATED ALWAYS AS IDENTITY UNIQUE,
  topic        text        NOT NULL,
  message_key  text        NOT NULL,
  type         text        NOT NULL,
  -- `json`, não `jsonb`: guarda o envelope com os campos na ordem em que foi escrito.
  payload      json        NOT NULL,
  -- `traceparent` e `tracestate` do comando que causou a resposta.
  headers      jsonb       NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);

-- O relay só lê as pendentes; os índices parciais ficam pequenos com o tempo.
CREATE INDEX outbox_pending ON outbox (seq) WHERE published_at IS NULL;
CREATE INDEX outbox_pending_by_key ON outbox (topic, message_key, seq)
  WHERE published_at IS NULL;
