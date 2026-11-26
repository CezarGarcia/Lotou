-- Fase 4: cada ingresso ganha o conteúdo do QR code, assinado com HMAC (ADR 15). Os ingressos
-- emitidos antes não têm código: só os novos vão para o PDF e para a portaria.
ALTER TABLE tickets ADD COLUMN code text;

-- Um código identifica um ingresso só.
CREATE UNIQUE INDEX tickets_code_uk ON tickets (code) WHERE code IS NOT NULL;
