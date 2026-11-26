package br.com.lotou.gateway.ratelimit;

import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;

import reactor.core.publisher.Mono;

import org.springframework.cloud.gateway.filter.ratelimit.KeyResolver;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ServerWebExchange;

/**
 * Quem está fazendo a requisição, para o rate limit: o {@code sub} do JWT, ou o IP do cliente para
 * quem não está autenticado. O IP entra como hash: nem ele vai parar numa chave do Redis.
 *
 * <p>O IP vem do primeiro endereço de {@code X-Forwarded-For} quando a conexão chega de uma rede
 * privada (o nginx da loja, no Compose); de fora, vale o endereço da conexão, que não dá para forjar.
 */
@Component
public class ClientKeyResolver implements KeyResolver {

    @Override
    public Mono<String> resolve(ServerWebExchange exchange) {
        return exchange.getPrincipal()
                .filter(JwtAuthenticationToken.class::isInstance)
                .map(principal -> "user:" + ((JwtAuthenticationToken) principal).getToken().getSubject())
                .switchIfEmpty(Mono.fromSupplier(() -> "ip:" + sha256(clientIp(exchange))));
    }

    static String clientIp(ServerWebExchange exchange) {
        InetSocketAddress remote = exchange.getRequest().getRemoteAddress();
        String forwarded = exchange.getRequest().getHeaders().getFirst("X-Forwarded-For");
        boolean fromProxy = remote != null && remote.getAddress() != null
                && (remote.getAddress().isSiteLocalAddress() || remote.getAddress().isLoopbackAddress());
        if (fromProxy && forwarded != null && !forwarded.isBlank()) {
            return forwarded.split(",")[0].trim();
        }
        return remote == null || remote.getAddress() == null ? "unknown" : remote.getAddress().getHostAddress();
    }

    private static String sha256(String value) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(value.getBytes(StandardCharsets.UTF_8)));
        }
        catch (NoSuchAlgorithmException ex) {
            throw new IllegalStateException(ex);
        }
    }
}
