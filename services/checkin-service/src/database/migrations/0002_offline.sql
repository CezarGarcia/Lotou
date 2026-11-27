-- Portaria offline (ADR 38). O leitor valida no aparelho quando o servidor não
-- responde e envia as leituras depois, em lote.

-- O pacote offline traz todos os ingressos de um show.
CREATE INDEX valid_tickets_show ON valid_tickets (show_id);

-- Cada leitura offline recebida, com o que aconteceu com ela. O `id` é gerado
-- no aparelho: reenviar a mesma leitura devolve o mesmo resultado, sem gravar
-- de novo.
CREATE TABLE offline_scans (
  id          uuid        PRIMARY KEY,
  show_id     uuid        NOT NULL,
  gate        text        NOT NULL,
  device_id   uuid        NOT NULL,
  -- Nulo quando o código não passou na assinatura: o ID nele não é confiável.
  ticket_id   uuid,
  -- O horário da leitura no aparelho; vira o `checked_in_at` da entrada.
  scanned_at  timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  outcome     text        NOT NULL
    CHECK (outcome IN ('RECORDED', 'DUPLICATE', 'CONFLICT', 'REJECTED')),
  kind        text
    CHECK (kind IN ('DUPLICATE', 'CANCELLED', 'UNKNOWN', 'WRONG_SHOW')),
  reason      text
    CHECK (reason IN ('INVALID_CODE', 'INVALID_TIME')),
  CONSTRAINT offline_scans_outcome_fields CHECK (
    CASE outcome
      WHEN 'RECORDED'  THEN kind IS NULL AND reason IS NULL AND ticket_id IS NOT NULL
      WHEN 'DUPLICATE' THEN kind IS NOT DISTINCT FROM 'DUPLICATE' AND reason IS NULL
                            AND ticket_id IS NOT NULL
      WHEN 'CONFLICT'  THEN kind IS NOT NULL AND kind IS DISTINCT FROM 'DUPLICATE'
                            AND reason IS NULL AND ticket_id IS NOT NULL
      ELSE kind IS NULL AND reason IS NOT NULL
    END)
);

CREATE INDEX offline_scans_show ON offline_scans (show_id, received_at);

-- Quem entrou sem internet com um ingresso que não valia: já usado (por outro
-- aparelho, ou online), cancelado, desconhecido ou de outro show. A pessoa já
-- está lá dentro; o conflito fica registrado, com métrica e alerta. A chave é
-- a leitura que o causou.
CREATE TABLE offline_conflicts (
  id                  uuid        PRIMARY KEY REFERENCES offline_scans (id),
  show_id             uuid        NOT NULL,
  ticket_id           uuid        NOT NULL,
  gate                text        NOT NULL,
  device_id           uuid        NOT NULL,
  scanned_at          timestamptz NOT NULL,
  kind                text        NOT NULL
    CHECK (kind IN ('DUPLICATE', 'CANCELLED', 'UNKNOWN', 'WRONG_SHOW')),
  -- A entrada que valeu, nas entradas duplas.
  first_gate          text,
  first_checked_in_at timestamptz,
  detected_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT offline_conflicts_first_entry CHECK (
    (first_gate IS NULL) = (first_checked_in_at IS NULL)
    AND (kind = 'DUPLICATE' OR first_gate IS NULL))
);

-- O alerta "Entrada indevida pela portaria offline" olha os últimos minutos.
CREATE INDEX offline_conflicts_detected ON offline_conflicts (detected_at);
CREATE INDEX offline_conflicts_show ON offline_conflicts (show_id);
