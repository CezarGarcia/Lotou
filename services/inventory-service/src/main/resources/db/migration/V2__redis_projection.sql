-- Fase 2: com o motor Redis, o Postgres é a cópia durável do estado de venda, alimentada pelo
-- stream:reservations (ADR 26).
--
-- Cada entrada do stream leva o estado final do que mudou (contador do lote, status da cadeira,
-- cota do CPF, status da reserva), e não a diferença. A coluna redis_seq guarda a posição da
-- entrada no stream que gravou a linha: uma entrada mais antiga nunca sobrescreve uma mais nova,
-- então vários consumidores podem aplicar o stream em qualquer ordem.

ALTER TABLE lots ADD COLUMN redis_seq bigint NOT NULL DEFAULT 0;
ALTER TABLE seats ADD COLUMN redis_seq bigint NOT NULL DEFAULT 0;
ALTER TABLE reservations ADD COLUMN redis_seq bigint NOT NULL DEFAULT 0;
ALTER TABLE purchase_limits ADD COLUMN redis_seq bigint NOT NULL DEFAULT 0;

-- Os itens de uma reserva são gravados uma vez só, mesmo que a entrada seja aplicada de novo.
ALTER TABLE reservation_items ADD CONSTRAINT reservation_items_position_uk UNIQUE (reservation_id, position);
