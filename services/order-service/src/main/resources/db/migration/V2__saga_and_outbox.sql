-- Fase 3: o checkout vira uma saga orquestrada pelo order-service, com os passos no Kafka.

-- O job de retomada da fase 1 sai: quem retoma agora é a saga (saga_state).
DROP INDEX orders_pending_idx;
ALTER TABLE orders DROP COLUMN processing_until;

-- Pagamento estornado: o pedido foi cancelado depois de o pagamento ter sido aprovado.
ALTER TABLE orders DROP CONSTRAINT orders_payment_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_payment_status_check
    CHECK (payment_status IN ('AUTHORIZED', 'DECLINED', 'REFUNDED'));

-- Passo atual da saga de cada pedido. É o que permite retomar depois de uma queda ou de uma
-- resposta que não chegou: o job de prazos olha o passo e o prazo e repete o comando.
CREATE TABLE saga_state (
    order_id         uuid PRIMARY KEY REFERENCES orders (id),
    saga             text        NOT NULL CHECK (saga IN ('PURCHASE')),
    step             text        NOT NULL CHECK (step IN
                         ('AUTHORIZING_PAYMENT', 'CONFIRMING_RESERVATION', 'RELEASING_RESERVATION',
                          'REFUNDING_PAYMENT', 'COMPLETED', 'COMPENSATED')),
    -- A reserva foi devolvida à venda pelo inventory (expirou) antes de a saga chegar ao fim.
    reservation_lost boolean     NOT NULL DEFAULT false,
    -- Por que o pedido vai ser cancelado, quando a saga está compensando.
    cancel_reason    text CHECK (cancel_reason IN
                         ('PAYMENT_DECLINED', 'RESERVATION_EXPIRED', 'TICKET_CONFLICT')),
    -- Quantas vezes o comando do passo atual foi enviado.
    attempts         integer     NOT NULL DEFAULT 1,
    -- Até quando a resposta do passo atual é esperada.
    deadline         timestamptz,
    started_at       timestamptz NOT NULL,
    updated_at       timestamptz NOT NULL
);

-- O job de prazos só olha as sagas em andamento.
CREATE INDEX saga_state_deadline_idx ON saga_state (deadline)
    WHERE step NOT IN ('COMPLETED', 'COMPENSATED');

-- Mensagens a publicar no Kafka, gravadas na mesma transação da mudança que as causou. O relay
-- publica em ordem e marca como publicada.
CREATE TABLE outbox (
    -- UUID v7: é o eventId do envelope, e a ordem de publicação.
    id           uuid PRIMARY KEY,
    topic        text        NOT NULL,
    message_key  text        NOT NULL,
    type         text        NOT NULL,
    -- O envelope inteiro, como vai para o Kafka.
    envelope     jsonb       NOT NULL,
    -- Contexto do trace de quem causou a mensagem, para o trace atravessar o broker.
    traceparent  text,
    created_at   timestamptz NOT NULL,
    published_at timestamptz
);

CREATE INDEX outbox_unpublished_idx ON outbox (id) WHERE published_at IS NULL;

-- Mensagens já processadas pelos consumidores deste serviço: uma mensagem repetida é ignorada.
CREATE TABLE processed_events (
    event_id     uuid PRIMARY KEY,
    topic        text        NOT NULL,
    type         text        NOT NULL,
    processed_at timestamptz NOT NULL
);
