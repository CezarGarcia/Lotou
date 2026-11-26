package br.com.lotou.inventory.support;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;

/**
 * Teste de integração: a aplicação inteira contra um Postgres real (Testcontainers). Os jobs
 * agendados ficam desligados; cada teste chama o job que quer exercitar.
 */
@Target(ElementType.TYPE)
@Retention(RetentionPolicy.RUNTIME)
@SpringBootTest(properties = "lotou.inventory.jobs.enabled=false")
@AutoConfigureMockMvc
@Import({TestInfrastructure.class, Fixtures.class})
public @interface IntegrationTest {
}
