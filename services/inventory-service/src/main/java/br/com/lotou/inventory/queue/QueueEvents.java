package br.com.lotou.inventory.queue;

import java.io.IOException;
import java.time.Duration;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import org.springframework.beans.factory.DisposableBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

/**
 * Posição na fila ao vivo, por Server-Sent Events: a cada segundo, cada comprador conectado recebe
 * um evento {@code status}. Quando é admitido, recebe o último evento e o fluxo termina.
 *
 * <p>SSE e não WebSocket: o fluxo é de mão única, do servidor para o navegador, e passa pelo
 * gateway como HTTP comum (ADR 17). Na fase 2 o próprio inventory, dono da fila, serve o fluxo; na
 * fase 4 os fluxos de tempo real passam pelo analytics-service (ADR 26).
 */
@Component
@ConditionalOnProperty(name = "lotou.inventory.engine", havingValue = "redis", matchIfMissing = true)
public class QueueEvents implements DisposableBean {

    private static final Logger log = LoggerFactory.getLogger(QueueEvents.class);
    /** O navegador reconecta sozinho; a conexão não precisa durar a fila inteira. */
    private static final Duration CONNECTION_TIMEOUT = Duration.ofMinutes(30);

    private record Subscriber(UUID showId, String userId, SseEmitter emitter) {
    }

    private final QueueService queue;
    private final Map<SseEmitter, Subscriber> subscribers = new ConcurrentHashMap<>();
    private final ScheduledExecutorService ticker = Executors.newSingleThreadScheduledExecutor(
            Thread.ofPlatform().name("queue-events").daemon().factory());

    public QueueEvents(QueueService queue) {
        this.queue = queue;
        this.ticker.scheduleWithFixedDelay(this::tick, 1, 1, TimeUnit.SECONDS);
    }

    public SseEmitter subscribe(UUID showId, String userId) {
        var emitter = new SseEmitter(CONNECTION_TIMEOUT.toMillis());
        var subscriber = new Subscriber(showId, userId, emitter);
        emitter.onCompletion(() -> this.subscribers.remove(emitter));
        emitter.onTimeout(() -> this.subscribers.remove(emitter));
        emitter.onError(error -> this.subscribers.remove(emitter));
        this.subscribers.put(emitter, subscriber);
        send(subscriber);
        return emitter;
    }

    /** Uma rodada: o status atual de cada comprador conectado. */
    void tick() {
        this.subscribers.values().forEach(this::send);
    }

    private void send(Subscriber subscriber) {
        try {
            QueueStatus status = this.queue.status(subscriber.showId(), subscriber.userId());
            subscriber.emitter().send(SseEmitter.event().name("status").data(status, MediaType.APPLICATION_JSON));
            if (status.status() == QueueStatus.State.ADMITTED || status.status() == QueueStatus.State.CLOSED
                    || status.status() == QueueStatus.State.NOT_REQUIRED) {
                this.subscribers.remove(subscriber.emitter());
                subscriber.emitter().complete();
            }
        }
        catch (IOException | IllegalStateException ex) {
            // O navegador fechou a conexão.
            this.subscribers.remove(subscriber.emitter());
        }
        catch (RuntimeException ex) {
            log.warn("Falha ao enviar a posição na fila: {}", ex.toString());
        }
    }

    @Override
    public void destroy() {
        this.ticker.shutdownNow();
        this.subscribers.keySet().forEach(SseEmitter::complete);
    }
}
