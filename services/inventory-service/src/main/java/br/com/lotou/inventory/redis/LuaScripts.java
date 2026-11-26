package br.com.lotou.inventory.redis;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

import io.opentelemetry.api.GlobalOpenTelemetry;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.SpanKind;
import io.opentelemetry.api.trace.StatusCode;
import io.opentelemetry.api.trace.Tracer;
import io.opentelemetry.context.Scope;

import org.springframework.core.io.ClassPathResource;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.DefaultRedisScript;
import org.springframework.data.redis.core.script.RedisScript;
import org.springframework.stereotype.Component;

/**
 * Os scripts Lua do inventory ({@code src/main/resources/redis}). Cada script é a biblioteca comum
 * ({@code lib.lua}) seguida do corpo dele. O Spring envia o script por {@code EVALSHA} e, se o Redis
 * ainda não o conhece (depois de um restart, por exemplo), por {@code EVAL}.
 */
@Component
public class LuaScripts {

    /** O primeiro elemento é o código do resultado ({@code OK}, {@code SOLD_OUT}...). */
    public record Result(List<String> values) {

        public String code() {
            return this.values.getFirst();
        }

        public String value(int index) {
            return this.values.size() > index ? this.values.get(index) : null;
        }

        public boolean is(String code) {
            return code().equals(code);
        }
    }

    private static final Tracer TRACER = GlobalOpenTelemetry.getTracer("lotou.inventory.redis");

    private final StringRedisTemplate redis;
    private final Map<String, RedisScript<List>> scripts = new ConcurrentHashMap<>();
    private final String library;

    public LuaScripts(StringRedisTemplate redis) {
        this.redis = redis;
        this.library = read("lib");
    }

    /**
     * Roda um script e devolve o resultado. Os argumentos viram texto.
     *
     * <p>O Java agent do OpenTelemetry ainda não instrumenta o Lettuce 7, então o span da chamada ao
     * Redis é criado aqui, com as convenções semânticas de banco de dados: o trace da reserva chega
     * até o Redis como chegaria até o Postgres.
     */
    public Result run(String name, List<String> keys, Object... args) {
        RedisScript<List> script = this.scripts.computeIfAbsent(name,
                key -> new DefaultRedisScript<>(this.library + "\n" + read(key), List.class));
        Span span = TRACER.spanBuilder("EVALSHA " + name)
                .setSpanKind(SpanKind.CLIENT)
                .setAttribute("db.system.name", "redis")
                .setAttribute("db.operation.name", "EVALSHA")
                .setAttribute("db.query.summary", "EVALSHA " + name + ".lua")
                .startSpan();
        try (Scope ignored = span.makeCurrent()) {
            List<?> raw = this.redis.execute(script, keys, Arrays.stream(args).map(String::valueOf).toArray());
            Result result = new Result(raw == null ? List.of() : raw.stream().map(String::valueOf).toList());
            if (!result.values().isEmpty()) {
                span.setAttribute("lotou.redis.result", result.code());
            }
            return result;
        }
        catch (RuntimeException ex) {
            span.setStatus(StatusCode.ERROR);
            span.recordException(ex);
            throw ex;
        }
        finally {
            span.end();
        }
    }

    public Result run(String name, Object... args) {
        return run(name, List.of(), args);
    }

    private static String read(String name) {
        try {
            return new ClassPathResource("redis/" + name + ".lua").getContentAsString(StandardCharsets.UTF_8);
        }
        catch (IOException ex) {
            throw new UncheckedIOException("Script Lua não encontrado: " + name, ex);
        }
    }
}
