package br.com.lotou.inventory.messaging;

import org.apache.kafka.common.TopicPartition;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import tools.jackson.core.JacksonException;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.kafka.listener.DeadLetterPublishingRecoverer;
import org.springframework.kafka.listener.DefaultErrorHandler;
import org.springframework.util.backoff.ExponentialBackOff;

/**
 * O que acontece com uma mensagem que o consumidor não consegue processar: tenta de novo com
 * espera crescente (o banco pode ter piscado) e, esgotadas as tentativas, a manda para
 * {@code <tópico>.dlt} e segue para a próxima. Mensagem malformada vai direto: repetir não muda
 * o resultado.
 */
@Configuration
public class KafkaConfig {

    private static final Logger log = LoggerFactory.getLogger(KafkaConfig.class);

    @Bean
    DefaultErrorHandler kafkaErrorHandler(KafkaTemplate<String, String> kafka) {
        var recoverer = new DeadLetterPublishingRecoverer(kafka, (record, ex) -> {
            log.error("Mensagem enviada para a DLT depois das tentativas: tópico {} offset {}", record.topic(),
                    record.offset(), ex);
            return new TopicPartition(Topics.deadLetterOf(record.topic()), record.partition());
        });
        var backOff = new ExponentialBackOff(200, 2.0);
        backOff.setMaxInterval(5_000);
        backOff.setMaxElapsedTime(30_000);
        var handler = new DefaultErrorHandler(recoverer, backOff);
        handler.addNotRetryableExceptions(JacksonException.class, MalformedMessageException.class);
        return handler;
    }
}
