package br.com.lotou.inventory.redis;

import java.time.Duration;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.DefaultRedisScript;
import org.springframework.data.redis.core.script.RedisScript;
import org.springframework.stereotype.Component;

/**
 * Lock distribuído para jobs que só uma instância deve rodar por vez (carga do estoque, sorteio e
 * admissão da fila): {@code SET lock:{nome} token NX PX ttl}, e a liberação só apaga se o token for
 * o mesmo.
 *
 * <p>O limite é conhecido: se uma instância pausar por mais tempo que o TTL, outra pode pegar o
 * lock. Por isso nenhum job depende só dele para ser correto: cada passo protegido também é
 * idempotente (o sorteio, por exemplo, confere se já foi feito dentro do script).
 */
@Component
public class RedisLock {

    /** Um lock adquirido. Fechar solta o lock. */
    public interface Lease extends AutoCloseable {

        @Override
        void close();
    }

    private static final RedisScript<Long> UNLOCK = new DefaultRedisScript<>("""
            if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
            return 0
            """, Long.class);

    private final StringRedisTemplate redis;

    public RedisLock(StringRedisTemplate redis) {
        this.redis = redis;
    }

    public Optional<Lease> tryAcquire(String name, Duration ttl) {
        String key = RedisKeys.lock(name);
        String token = UUID.randomUUID().toString();
        if (!Boolean.TRUE.equals(this.redis.opsForValue().setIfAbsent(key, token, ttl))) {
            return Optional.empty();
        }
        return Optional.of(() -> this.redis.execute(UNLOCK, List.of(key), token));
    }
}
