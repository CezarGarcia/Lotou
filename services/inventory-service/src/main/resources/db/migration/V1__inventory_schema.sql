-- inventory-service: lotes, assentos e reservas.
--
-- Shows e setores são uma cópia do catálogo do event-service (dados de
-- referência). Lotes, assentos, reservas e limites por CPF são do inventory.

CREATE TABLE shows (
    id              uuid PRIMARY KEY,
    producer_id     text        NOT NULL,
    status          text        NOT NULL,
    starts_at       timestamptz NOT NULL,
    sales_start_at  timestamptz,
    sales_end_at    timestamptz,
    high_demand     boolean     NOT NULL DEFAULT false,
    -- Versão do show no catálogo: uma cópia mais antiga nunca sobrescreve uma mais nova.
    catalog_version integer     NOT NULL,
    -- Quando o inventory abriu e encerrou as vendas deste show.
    sales_opened_at timestamptz,
    sales_closed_at timestamptz,
    synced_at       timestamptz NOT NULL
);

-- O ID do setor vem do local, e o mesmo local recebe vários shows.
CREATE TABLE sectors (
    show_id  uuid    NOT NULL REFERENCES shows (id) ON DELETE CASCADE,
    id       uuid    NOT NULL,
    name     text    NOT NULL,
    kind     text    NOT NULL CHECK (kind IN ('GENERAL_ADMISSION', 'RESERVED_SEATING')),
    capacity integer NOT NULL CHECK (capacity > 0),
    position integer NOT NULL,
    PRIMARY KEY (show_id, id)
);

CREATE TABLE lots (
    id          uuid PRIMARY KEY,
    show_id     uuid    NOT NULL,
    sector_id   uuid    NOT NULL,
    name        text    NOT NULL,
    -- Dinheiro em centavos, inteiro.
    price_cents bigint  NOT NULL CHECK (price_cents >= 0),
    quantity    integer NOT NULL CHECK (quantity > 0),
    -- Ingressos que ainda podem ser reservados. A constraint é a última defesa
    -- contra venda além da capacidade: o banco recusa um contador negativo.
    available   integer NOT NULL CHECK (available >= 0),
    -- Ordem de virada dentro do setor.
    position    integer NOT NULL,
    opens_at    timestamptz,
    status      text    NOT NULL CHECK (status IN ('SCHEDULED', 'ON_SALE', 'SOLD_OUT', 'PAUSED', 'CLOSED')),
    FOREIGN KEY (show_id, sector_id) REFERENCES sectors (show_id, id) ON DELETE CASCADE,
    UNIQUE (show_id, sector_id, position)
);

-- Uma linha por cadeira numerada.
CREATE TABLE seats (
    id             uuid PRIMARY KEY,
    show_id        uuid NOT NULL,
    sector_id      uuid NOT NULL,
    -- Fileira e número, ex.: A-12.
    label          text NOT NULL,
    -- Ordem da cadeira dentro do setor, para listar o mapa.
    position       integer NOT NULL,
    status         text NOT NULL CHECK (status IN ('AVAILABLE', 'HELD', 'SOLD')),
    -- Reserva que segura ou comprou a cadeira.
    reservation_id uuid,
    FOREIGN KEY (show_id, sector_id) REFERENCES sectors (show_id, id) ON DELETE CASCADE,
    UNIQUE (show_id, sector_id, label)
);

CREATE TABLE reservations (
    id              uuid PRIMARY KEY,
    show_id         uuid        NOT NULL REFERENCES shows (id),
    sector_id       uuid        NOT NULL,
    -- Claim `sub` do comprador no Keycloak.
    buyer_id        text        NOT NULL,
    -- HMAC do CPF. O CPF em si nunca é gravado.
    cpf_hash        text        NOT NULL,
    status          text        NOT NULL CHECK (status IN ('HELD', 'CONFIRMED', 'RELEASED', 'EXPIRED')),
    quantity        integer     NOT NULL CHECK (quantity BETWEEN 1 AND 4),
    total_cents     bigint      NOT NULL CHECK (total_cents >= 0),
    expires_at      timestamptz NOT NULL,
    idempotency_key text        NOT NULL,
    request_hash    text        NOT NULL,
    created_at      timestamptz NOT NULL,
    updated_at      timestamptz NOT NULL,
    -- Duas requisições com a mesma Idempotency-Key: só uma consegue inserir.
    UNIQUE (buyer_id, idempotency_key)
);

-- O job de expiração só olha as reservas ainda seguradas.
CREATE INDEX reservations_held_expiry_idx ON reservations (expires_at) WHERE status = 'HELD';

-- Um item por ingresso, com o preço congelado no momento da reserva.
CREATE TABLE reservation_items (
    id               uuid PRIMARY KEY,
    reservation_id   uuid   NOT NULL REFERENCES reservations (id) ON DELETE CASCADE,
    -- Ordem do item na reserva (as cadeiras saem na ordem do mapa).
    position         integer NOT NULL,
    lot_id           uuid   NOT NULL REFERENCES lots (id),
    lot_name         text   NOT NULL,
    seat_id          uuid REFERENCES seats (id),
    seat_label       text,
    unit_price_cents bigint NOT NULL CHECK (unit_price_cents >= 0)
);

CREATE INDEX reservation_items_reservation_idx ON reservation_items (reservation_id);

-- Ingressos por CPF em cada show (reservas seguradas ou confirmadas).
CREATE TABLE purchase_limits (
    show_id  uuid    NOT NULL REFERENCES shows (id),
    cpf_hash text    NOT NULL,
    quantity integer NOT NULL CHECK (quantity >= 0),
    PRIMARY KEY (show_id, cpf_hash)
);

-- Até onde a leitura do catálogo do event-service já chegou (uma linha só).
CREATE TABLE catalog_sync (
    id              smallint PRIMARY KEY CHECK (id = 1),
    last_updated_at timestamptz
);

INSERT INTO catalog_sync (id) VALUES (1);
