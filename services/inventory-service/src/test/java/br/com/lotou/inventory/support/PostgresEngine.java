package br.com.lotou.inventory.support;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

import org.springframework.test.context.TestPropertySource;

/** Roda o teste com o motor de reserva da fase 1 (lock no Postgres) em vez do Redis. */
@Target(ElementType.TYPE)
@Retention(RetentionPolicy.RUNTIME)
@TestPropertySource(properties = "lotou.inventory.engine=postgres")
public @interface PostgresEngine {
}
