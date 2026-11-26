package br.com.lotou.inventory.reservation;

import br.com.lotou.inventory.support.IntegrationTest;
import br.com.lotou.inventory.support.PostgresEngine;

/** Motor Postgres (fase 1): lock no banco, a linha de base do ADR 3. */
@IntegrationTest
@PostgresEngine
class ReservationConcurrencyPostgresTests extends ReservationConcurrencyScenarios {
}
