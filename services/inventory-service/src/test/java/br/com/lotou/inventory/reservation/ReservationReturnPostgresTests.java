package br.com.lotou.inventory.reservation;

import br.com.lotou.inventory.support.IntegrationTest;
import br.com.lotou.inventory.support.PostgresEngine;

/** Motor Postgres (fase 1): a devolução numa transação, com as travas na ordem da reserva. */
@IntegrationTest
@PostgresEngine
class ReservationReturnPostgresTests extends ReservationReturnScenarios {
}
