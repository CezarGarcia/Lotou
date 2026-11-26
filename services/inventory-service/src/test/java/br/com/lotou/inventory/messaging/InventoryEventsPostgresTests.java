package br.com.lotou.inventory.messaging;

import br.com.lotou.inventory.support.IntegrationTest;
import br.com.lotou.inventory.support.PostgresEngine;

/** Motor Postgres: os fatos saem na transação da própria reserva. */
@IntegrationTest
@PostgresEngine
class InventoryEventsPostgresTests extends InventoryEventsScenarios {
}
