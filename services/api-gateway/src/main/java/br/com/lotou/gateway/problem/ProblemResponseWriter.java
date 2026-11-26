package br.com.lotou.gateway.problem;

import java.net.URI;
import java.util.Map;

import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.SpanContext;
import reactor.core.publisher.Mono;

import org.springframework.core.ResolvableType;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.MediaType;
import org.springframework.http.ProblemDetail;
import org.springframework.http.codec.HttpMessageWriter;
import org.springframework.http.codec.ServerCodecConfigurer;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ServerWebExchange;

/**
 * Escreve os erros do próprio gateway em Problem Details (RFC 9457), no mesmo formato dos
 * serviços: {@code type} em {@code urn:lotou:problem:<tipo>} e o {@code traceId} da requisição.
 */
@Component
public class ProblemResponseWriter {

    private static final String TYPE_PREFIX = "urn:lotou:problem:";
    private static final ResolvableType PROBLEM_TYPE = ResolvableType.forClass(ProblemDetail.class);

    private final HttpMessageWriter<ProblemDetail> writer;

    @SuppressWarnings("unchecked")
    public ProblemResponseWriter(ServerCodecConfigurer codecs) {
        this.writer = (HttpMessageWriter<ProblemDetail>) codecs.getWriters().stream()
                .filter(candidate -> candidate.canWrite(PROBLEM_TYPE, MediaType.APPLICATION_PROBLEM_JSON))
                .findFirst()
                .orElseThrow(() -> new IllegalStateException("Nenhum codec escreve application/problem+json"));
    }

    /** Problema com tipo próprio do Lotou. */
    public Mono<Void> write(ServerWebExchange exchange, HttpStatusCode status, String slug, String title,
            String detail) {
        ProblemDetail problem = ProblemDetail.forStatusAndDetail(status, detail);
        problem.setType(URI.create(TYPE_PREFIX + slug));
        problem.setTitle(title);
        return write(exchange, problem);
    }

    public Mono<Void> write(ServerWebExchange exchange, ProblemDetail problem) {
        var response = exchange.getResponse();
        if (response.isCommitted()) {
            return Mono.empty();
        }
        problem.setInstance(URI.create(exchange.getRequest().getPath().value()));
        SpanContext span = Span.current().getSpanContext();
        if (span.isValid()) {
            problem.setProperty("traceId", span.getTraceId());
        }
        response.setStatusCode(HttpStatusCode.valueOf(problem.getStatus()));
        return this.writer.write(Mono.just(problem), PROBLEM_TYPE, MediaType.APPLICATION_PROBLEM_JSON, response,
                Map.of());
    }
}
