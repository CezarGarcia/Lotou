-- Cópia local dos ingressos, alimentada por `order.events` (ADR 14). O nome é
-- o do documento do projeto; a linha fica mesmo depois de usada ou cancelada,
-- para o leitor dizer "cancelado" ou "já utilizado" em vez de "desconhecido".
CREATE TABLE valid_tickets (
  ticket_id     uuid        PRIMARY KEY,
  order_id      uuid        NOT NULL,
  show_id       uuid        NOT NULL,
  sector_id     uuid        NOT NULL,
  sector_name   text        NOT NULL,
  -- Cadeira numerada (`A-5`); nula na pista.
  seat          text,
  status        text        NOT NULL
    CHECK (status IN ('VALID', 'USED', 'CANCELLED')),
  issued_at     timestamptz NOT NULL,
  cancelled_at  timestamptz,
  cancel_reason text
    CHECK (cancel_reason IN ('ORDER_CANCELLED', 'SHOW_CANCELLED')),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT valid_tickets_cancelled_fields
    CHECK ((status = 'CANCELLED') = (cancelled_at IS NOT NULL))
);

CREATE INDEX valid_tickets_order ON valid_tickets (order_id);

-- Entradas registradas. A constraint única em `ticket_id` é quem decide, no
-- fim, que um ingresso libera uma única entrada: vale mesmo com o Redis fora
-- ou sem os dados dele.
CREATE TABLE checkins (
  id            uuid        PRIMARY KEY,
  ticket_id     uuid        NOT NULL UNIQUE REFERENCES valid_tickets (ticket_id),
  show_id       uuid        NOT NULL,
  gate          text        NOT NULL,
  checked_in_at timestamptz NOT NULL
);

CREATE INDEX checkins_show_gate ON checkins (show_id, gate);

-- Leituras recusadas, para o resumo da portaria. Gravadas em lote, junto com
-- o `CheckinRejected` de cada uma no outbox.
CREATE TABLE checkin_rejections (
  id          uuid        PRIMARY KEY,
  show_id     uuid        NOT NULL,
  gate        text        NOT NULL,
  reason      text        NOT NULL
    CHECK (reason IN ('INVALID_CODE', 'UNKNOWN_TICKET', 'CANCELLED',
                      'ALREADY_USED', 'WRONG_SHOW', 'NOT_OPEN')),
  -- Nulo quando o código não passou na assinatura: o ID nele não é confiável.
  ticket_id   uuid,
  rejected_at timestamptz NOT NULL
);

CREATE INDEX checkin_rejections_show ON checkin_rejections (show_id);

-- Cópia local do catálogo (`shows.catalog`): só o que a portaria usa. Fica a
-- versão mais alta de cada show.
CREATE TABLE shows (
  show_id       uuid        PRIMARY KEY,
  version       integer     NOT NULL CHECK (version >= 1),
  producer_id   text        NOT NULL,
  status        text        NOT NULL,
  title         text        NOT NULL,
  artist        text        NOT NULL,
  starts_at     timestamptz NOT NULL,
  doors_open_at timestamptz,
  venue_name    text        NOT NULL,
  -- Fuso do local (IANA, `America/Sao_Paulo`): define o "hoje" da portaria.
  timezone      text        NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX shows_starts_at ON shows (starts_at, show_id);

-- Mensagens de `order.events` já aplicadas: o efeito e o `eventId` entram na
-- mesma transação, então uma mensagem entregue de novo é reconhecida e ignorada.
CREATE TABLE processed_events (
  event_id     uuid        PRIMARY KEY,
  type         text        NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now()
);

-- Eventos a publicar em `checkin.events`, gravados na mesma transação da
-- entrada (ou do lote de recusas). `seq` dá a ordem de publicação; `id` é o
-- `eventId` da mensagem, que não muda se o relay precisar publicar de novo.
CREATE TABLE outbox (
  id           uuid        PRIMARY KEY,
  seq          bigint      GENERATED ALWAYS AS IDENTITY UNIQUE,
  topic        text        NOT NULL,
  message_key  text        NOT NULL,
  type         text        NOT NULL,
  -- `json`, não `jsonb`: guarda o envelope com os campos na ordem em que foi escrito.
  payload      json        NOT NULL,
  -- `traceparent` e `tracestate` da leitura que causou o evento.
  headers      jsonb       NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);

-- O relay só lê as pendentes; o índice parcial fica pequeno com o tempo.
CREATE INDEX outbox_pending ON outbox (seq) WHERE published_at IS NULL;
