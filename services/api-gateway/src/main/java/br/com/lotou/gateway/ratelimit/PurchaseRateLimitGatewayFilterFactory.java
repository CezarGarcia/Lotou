package br.com.lotou.gateway.ratelimit;

import java.util.List;

import br.com.lotou.gateway.problem.ProblemResponseWriter;
import org.springframework.cloud.gateway.filter.GatewayFilter;
import org.springframework.cloud.gateway.filter.factory.AbstractGatewayFilterFactory;
import org.springframework.cloud.gateway.filter.ratelimit.RedisRateLimiter;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;

/**
 * Rate limit por token bucket no {@code redis-core}, com o {@code RedisRateLimiter} do Spring Cloud
 * Gateway. Barra robôs e cliques em excesso antes de chegarem ao serviço (Fluxo A).
 *
 * <p>Cada usuário tem um balde por limite ({@code name}): reservar, comprar e entrar na fila não
 * dividem o mesmo balde. Acima do limite, responde 429 em Problem Details, com {@code Retry-After}.
 * O event-service tem o outro algoritmo, a janela deslizante, para comparar os dois.
 *
 * <p>Com o Redis fora do ar, o {@code RedisRateLimiter} deixa passar: o rate limit é proteção, não
 * pode derrubar a venda.
 */
@Component
public class PurchaseRateLimitGatewayFilterFactory
        extends AbstractGatewayFilterFactory<PurchaseRateLimitGatewayFilterFactory.Config> {

    /**
     * @param name nome do limite, parte da chave no Redis
     * @param replenishRate quantas requisições por segundo o balde repõe
     * @param burstCapacity o tamanho do balde: quantas requisições de uma vez
     */
    public record Config(String name, int replenishRate, int burstCapacity) {
    }

    private final RedisRateLimiter limiter;
    private final ClientKeyResolver keys;
    private final ProblemResponseWriter problems;

    public PurchaseRateLimitGatewayFilterFactory(RedisRateLimiter limiter, ClientKeyResolver keys,
            ProblemResponseWriter problems) {
        super(Config.class);
        this.limiter = limiter;
        this.keys = keys;
        this.problems = problems;
    }

    @Override
    public List<String> shortcutFieldOrder() {
        return List.of("name", "replenishRate", "burstCapacity");
    }

    @Override
    public GatewayFilter apply(Config config) {
        String limit = "lotou-" + config.name();
        this.limiter.getConfig().put(limit, new RedisRateLimiter.Config()
                .setReplenishRate(config.replenishRate())
                .setBurstCapacity(config.burstCapacity())
                .setRequestedTokens(1));
        return (exchange, chain) -> this.keys.resolve(exchange)
                .flatMap(key -> this.limiter.isAllowed(limit, config.name() + ":" + key))
                .flatMap(response -> {
                    var headers = exchange.getResponse().getHeaders();
                    response.getHeaders().forEach(headers::set);
                    if (response.isAllowed()) {
                        return chain.filter(exchange);
                    }
                    headers.set("Retry-After", "1");
                    return this.problems.write(exchange, HttpStatus.TOO_MANY_REQUESTS, "rate-limited",
                            "Muitas requisições", "Você fez requisições demais em pouco tempo. Tente de novo em instantes.");
                });
    }

    @Override
    public String name() {
        return "PurchaseRateLimit";
    }
}
