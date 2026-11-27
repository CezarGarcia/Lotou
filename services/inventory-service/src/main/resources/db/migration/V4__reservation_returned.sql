-- Fase 6: o pedido cancelado e reembolsado devolve à venda os ingressos da reserva confirmada
-- (comando ReturnTickets). A reserva passa de CONFIRMED a RETURNED, e o fato ReservationReturned
-- sai pelo outbox, gravado pelo mesmo trigger dos outros fatos da reserva.

ALTER TABLE reservations DROP CONSTRAINT reservations_status_check;
ALTER TABLE reservations ADD CONSTRAINT reservations_status_check
    CHECK (status IN ('HELD', 'CONFIRMED', 'RELEASED', 'EXPIRED', 'RETURNED'));

-- Igual à da V3, com o ramo de RETURNED.
CREATE OR REPLACE FUNCTION reservation_event() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
    lot uuid;
    labels jsonb;
    at timestamptz := coalesce(NEW.updated_at, now());
BEGIN
    IF TG_OP = 'UPDATE' AND OLD.status = NEW.status THEN
        RETURN NULL;
    END IF;
    IF NEW.status NOT IN ('CONFIRMED', 'RELEASED', 'EXPIRED', 'RETURNED') THEN
        RETURN NULL;
    END IF;
    SELECT i.lot_id INTO lot FROM reservation_items i WHERE i.reservation_id = NEW.id ORDER BY i.position LIMIT 1;
    SELECT coalesce(jsonb_agg(i.seat_label ORDER BY i.position) FILTER (WHERE i.seat_label IS NOT NULL), '[]')
        INTO labels FROM reservation_items i WHERE i.reservation_id = NEW.id;
    IF NEW.status = 'CONFIRMED' THEN
        PERFORM enqueue_inventory_event(NEW.show_id, 'ReservationConfirmed', jsonb_build_object(
            'reservationId', NEW.id, 'showId', NEW.show_id, 'sectorId', NEW.sector_id, 'lotId', lot,
            'quantity', NEW.quantity, 'seats', labels, 'confirmedAt', iso_utc(at)), at);
    ELSIF NEW.status = 'RETURNED' THEN
        PERFORM enqueue_inventory_event(NEW.show_id, 'ReservationReturned', jsonb_build_object(
            'reservationId', NEW.id, 'showId', NEW.show_id, 'sectorId', NEW.sector_id, 'lotId', lot,
            'quantity', NEW.quantity, 'seats', labels, 'returnedAt', iso_utc(at)), at);
    ELSE
        PERFORM enqueue_inventory_event(NEW.show_id, 'ReservationReleased', jsonb_build_object(
            'reservationId', NEW.id, 'showId', NEW.show_id, 'sectorId', NEW.sector_id, 'lotId', lot,
            'quantity', NEW.quantity, 'seats', labels, 'reason', NEW.status, 'releasedAt', iso_utc(at)), at);
    END IF;
    RETURN NULL;
END
$$;
