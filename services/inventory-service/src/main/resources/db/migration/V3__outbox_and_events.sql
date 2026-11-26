-- Fase 3: o inventory publica no Kafka os fatos sobre reservas e lotes (inventory.events), e o
-- catálogo chega pelo tópico shows.catalog em vez do polling.

-- O polling do catálogo saiu: o offset do consumer group guarda até onde a leitura chegou.
DROP TABLE catalog_sync;

-- Mensagens a publicar no Kafka, gravadas na mesma transação da mudança que as causou. O relay
-- publica em ordem e marca como publicada. Mesmo formato do outbox do order-service.
CREATE TABLE outbox (
    -- UUID v7: é o eventId do envelope, e a ordem de publicação.
    id           uuid PRIMARY KEY,
    topic        text        NOT NULL,
    message_key  text        NOT NULL,
    type         text        NOT NULL,
    envelope     jsonb       NOT NULL,
    traceparent  text,
    created_at   timestamptz NOT NULL,
    published_at timestamptz
);

CREATE INDEX outbox_unpublished_idx ON outbox (id) WHERE published_at IS NULL;

-- Data em UTC no formato dos contratos (ISO 8601, milissegundos).
CREATE FUNCTION iso_utc(value timestamptz) RETURNS text
    LANGUAGE sql IMMUTABLE AS
$$ SELECT to_char(value AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') $$;

-- Enfileira um fato de inventory.events (chave: o show). O contexto do trace vem da transação,
-- quando a aplicação o informou (SET LOCAL lotou.traceparent).
CREATE FUNCTION enqueue_inventory_event(show uuid, event_type text, payload jsonb, at timestamptz)
    RETURNS void LANGUAGE plpgsql AS
$$
DECLARE
    event_id uuid := uuidv7();
BEGIN
    INSERT INTO outbox (id, topic, message_key, type, envelope, traceparent, created_at)
    VALUES (event_id, 'inventory.events', show::text, event_type,
            jsonb_build_object('eventId', event_id, 'type', event_type, 'version', 1,
                               'occurredAt', iso_utc(at), 'payload', payload),
            nullif(current_setting('lotou.traceparent', true), ''), clock_timestamp());
END
$$;

-- Fatos sobre a reserva: confirmada, ou devolvida à venda (liberada ou expirada).
--
-- É um trigger e não código da aplicação de propósito: o status da reserva muda em vários lugares
-- (os dois motores de reserva, a projeção do stream do Redis, a expiração), e o trigger garante
-- que toda mudança, venha de onde vier, gera o fato na mesma transação. É adiado até o commit para
-- enxergar os itens da reserva, que a projeção grava depois da reserva.
CREATE FUNCTION reservation_event() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
    lot uuid;
    labels jsonb;
    at timestamptz := coalesce(NEW.updated_at, now());
BEGIN
    IF TG_OP = 'UPDATE' AND OLD.status = NEW.status THEN
        RETURN NULL;
    END IF;
    IF NEW.status NOT IN ('CONFIRMED', 'RELEASED', 'EXPIRED') THEN
        RETURN NULL;
    END IF;
    SELECT i.lot_id INTO lot FROM reservation_items i WHERE i.reservation_id = NEW.id ORDER BY i.position LIMIT 1;
    SELECT coalesce(jsonb_agg(i.seat_label ORDER BY i.position) FILTER (WHERE i.seat_label IS NOT NULL), '[]')
        INTO labels FROM reservation_items i WHERE i.reservation_id = NEW.id;
    IF NEW.status = 'CONFIRMED' THEN
        PERFORM enqueue_inventory_event(NEW.show_id, 'ReservationConfirmed', jsonb_build_object(
            'reservationId', NEW.id, 'showId', NEW.show_id, 'sectorId', NEW.sector_id, 'lotId', lot,
            'quantity', NEW.quantity, 'seats', labels, 'confirmedAt', iso_utc(at)), at);
    ELSE
        PERFORM enqueue_inventory_event(NEW.show_id, 'ReservationReleased', jsonb_build_object(
            'reservationId', NEW.id, 'showId', NEW.show_id, 'sectorId', NEW.sector_id, 'lotId', lot,
            'quantity', NEW.quantity, 'seats', labels, 'reason', NEW.status, 'releasedAt', iso_utc(at)), at);
    END IF;
    RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER reservation_events
    AFTER INSERT OR UPDATE OF status ON reservations
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION reservation_event();

-- Fatos sobre o lote: esgotou, ou passou a vender (abertura, virada, reabertura ou retomada).
CREATE FUNCTION lot_event() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
    at timestamptz := now();
BEGIN
    IF OLD.status = NEW.status THEN
        RETURN NULL;
    END IF;
    IF NEW.status = 'SOLD_OUT' THEN
        PERFORM enqueue_inventory_event(NEW.show_id, 'LotSoldOut', jsonb_build_object(
            'showId', NEW.show_id, 'sectorId', NEW.sector_id, 'lotId', NEW.id, 'soldOutAt', iso_utc(at)), at);
    ELSIF NEW.status = 'ON_SALE' THEN
        PERFORM enqueue_inventory_event(NEW.show_id, 'LotOpened', jsonb_build_object(
            'showId', NEW.show_id, 'sectorId', NEW.sector_id, 'lotId', NEW.id, 'priceCents', NEW.price_cents,
            'available', NEW.available, 'openedAt', iso_utc(at)), at);
    END IF;
    RETURN NULL;
END
$$;

CREATE TRIGGER lot_events
    AFTER UPDATE OF status ON lots
    FOR EACH ROW EXECUTE FUNCTION lot_event();
