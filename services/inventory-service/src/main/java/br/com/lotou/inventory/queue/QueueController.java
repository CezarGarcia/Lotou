package br.com.lotou.inventory.queue;

import java.util.UUID;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

/** Fila virtual de um show de alta demanda, para o comprador. */
@RestController
@RequestMapping("/v1/queue")
@ConditionalOnProperty(name = "lotou.inventory.engine", havingValue = "redis", matchIfMissing = true)
class QueueController {

    private final QueueService queue;
    private final QueueEvents events;

    QueueController(QueueService queue, QueueEvents events) {
        this.queue = queue;
        this.events = events;
    }

    /** Entra na fila. Idempotente: entrar de novo devolve a mesma posição. */
    @PostMapping("/{showId}")
    QueueStatus join(@PathVariable UUID showId, @AuthenticationPrincipal Jwt jwt) {
        return this.queue.join(showId, jwt.getSubject());
    }

    @GetMapping("/{showId}")
    QueueStatus status(@PathVariable UUID showId, @AuthenticationPrincipal Jwt jwt) {
        return this.queue.status(showId, jwt.getSubject());
    }

    /** A posição ao vivo, um evento {@code status} por segundo, até a admissão. */
    @GetMapping(path = "/{showId}/events", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    ResponseEntity<SseEmitter> events(@PathVariable UUID showId, @AuthenticationPrincipal Jwt jwt) {
        return sse(this.events.subscribe(showId, jwt.getSubject()));
    }

    /** Desliga o buffer do nginx para o fluxo, que precisa chegar ao navegador evento a evento. */
    static ResponseEntity<SseEmitter> sse(SseEmitter emitter) {
        return ResponseEntity.ok()
                .header(HttpHeaders.CACHE_CONTROL, "no-cache")
                .header("X-Accel-Buffering", "no")
                .body(emitter);
    }
}
