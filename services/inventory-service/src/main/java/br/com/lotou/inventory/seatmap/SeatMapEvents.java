package br.com.lotou.inventory.seatmap;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

import br.com.lotou.inventory.lot.SalesEngine;
import io.opentelemetry.api.GlobalOpenTelemetry;
import io.opentelemetry.api.metrics.LongUpDownCounter;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.json.JsonMapper;

import org.springframework.beans.factory.DisposableBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.data.redis.connection.Message;
import org.springframework.data.redis.connection.MessageListener;
import org.springframework.data.redis.connection.RedisConnectionFactory;
import org.springframework.data.redis.listener.PatternTopic;
import org.springframework.data.redis.listener.RedisMessageListenerContainer;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

/**
 * Mapa de assentos ao vivo, por Server-Sent Events.
 *
 * <p>Quem conecta recebe primeiro o mapa atual (evento {@code snapshot}, lido do bitmap) e depois só
 * as mudanças (eventos {@code seats}), que chegam pelo pub/sub {@code seatmap.{showId}}: o script de
 * reserva publica a cada cadeira segurada ou solta. Cada instância do serviço assina o canal e
 * repassa aos navegadores conectados a ela. Perder uma mensagem do pub/sub se corrige na próxima
 * leitura do bitmap (ADR 11).
 */
@Component
@ConditionalOnProperty(name = "lotou.inventory.engine", havingValue = "redis", matchIfMissing = true)
public class SeatMapEvents implements MessageListener, DisposableBean {

    private static final Logger log = LoggerFactory.getLogger(SeatMapEvents.class);
    private static final Duration CONNECTION_TIMEOUT = Duration.ofMinutes(30);
    /** Comentário periódico: mantém a conexão viva em proxies que fecham conexões ociosas. */
    private static final Duration HEARTBEAT = Duration.ofSeconds(15);

    /** O que o script Lua publica ({@code publish_seats} em {@code redis/lib.lua}). */
    record SeatChange(UUID sectorId, List<String> seats, boolean available) {
    }

    private record SectorKey(UUID showId, UUID sectorId) {
    }

    private final SalesEngine engine;
    private final Map<SectorKey, Set<SseEmitter>> subscribers = new ConcurrentHashMap<>();
    private final JsonMapper json = JsonMapper.builder()
            .disable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
            .build();
    private final ScheduledExecutorService heartbeat = Executors.newSingleThreadScheduledExecutor(
            Thread.ofPlatform().name("seatmap-heartbeat").daemon().factory());
    private final LongUpDownCounter connections;

    public SeatMapEvents(SalesEngine engine) {
        this.engine = engine;
        this.heartbeat.scheduleWithFixedDelay(this::beat, HEARTBEAT.toSeconds(), HEARTBEAT.toSeconds(),
                TimeUnit.SECONDS);
        this.connections = GlobalOpenTelemetry.getMeter("lotou.inventory").upDownCounterBuilder("seatmap_connections")
                .setDescription("Navegadores com o mapa de assentos aberto")
                .build();
    }

    public SseEmitter subscribe(UUID showId, UUID sectorId) {
        // Valida o setor antes de abrir o fluxo: setor inexistente é 404, não um fluxo vazio.
        this.engine.seats(showId, sectorId);
        var key = new SectorKey(showId, sectorId);
        var emitter = new SseEmitter(CONNECTION_TIMEOUT.toMillis());
        Runnable remove = () -> {
            Set<SseEmitter> set = this.subscribers.get(key);
            if (set != null && set.remove(emitter)) {
                this.connections.add(-1);
            }
        };
        emitter.onCompletion(remove);
        emitter.onTimeout(remove);
        emitter.onError(error -> remove.run());
        // Inscreve antes de ler o mapa: uma mudança entre as duas coisas já está no mapa ou chega
        // como evento, nunca se perde.
        this.subscribers.computeIfAbsent(key, ignored -> ConcurrentHashMap.newKeySet()).add(emitter);
        this.connections.add(1);
        try {
            emitter.send(SseEmitter.event().name("snapshot")
                    .data(Map.of("showId", showId, "sectorId", sectorId, "seats", this.engine.seats(showId, sectorId)),
                            MediaType.APPLICATION_JSON));
        }
        catch (IOException ex) {
            remove.run();
        }
        return emitter;
    }

    @Override
    public void onMessage(Message message, byte[] pattern) {
        String channel = new String(message.getChannel(), StandardCharsets.UTF_8);
        try {
            UUID showId = UUID.fromString(channel.substring("seatmap.".length()));
            SeatChange change = this.json.readValue(message.getBody(), SeatChange.class);
            Set<SseEmitter> emitters = this.subscribers.get(new SectorKey(showId, change.sectorId()));
            if (emitters == null || emitters.isEmpty()) {
                return;
            }
            for (SseEmitter emitter : emitters) {
                try {
                    emitter.send(SseEmitter.event().name("seats").data(change, MediaType.APPLICATION_JSON));
                }
                catch (IOException | IllegalStateException ex) {
                    emitters.remove(emitter);
                }
            }
        }
        catch (RuntimeException ex) {
            log.warn("Mensagem inválida no canal {}: {}", channel, ex.toString());
        }
    }

    private void beat() {
        this.subscribers.values().forEach(emitters -> emitters.forEach(emitter -> {
            try {
                emitter.send(SseEmitter.event().comment("keep-alive"));
            }
            catch (IOException | IllegalStateException ex) {
                emitters.remove(emitter);
            }
        }));
    }

    @Override
    public void destroy() {
        this.heartbeat.shutdownNow();
        this.subscribers.values().forEach(emitters -> emitters.forEach(SseEmitter::complete));
    }

    /** Uma assinatura de padrão para todos os shows: {@code seatmap.*}. */
    @Configuration(proxyBeanMethods = false)
    @ConditionalOnProperty(name = "lotou.inventory.engine", havingValue = "redis", matchIfMissing = true)
    static class Subscription {

        @Bean
        RedisMessageListenerContainer seatMapListener(RedisConnectionFactory connections, SeatMapEvents events) {
            var container = new RedisMessageListenerContainer();
            container.setConnectionFactory(connections);
            container.addMessageListener(events, new PatternTopic("seatmap.*"));
            return container;
        }
    }
}
