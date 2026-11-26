package br.com.lotou.gateway.problem;

import java.net.ConnectException;
import java.net.UnknownHostException;
import java.util.concurrent.TimeoutException;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import reactor.core.publisher.Mono;

import org.springframework.boot.webflux.error.ErrorWebExceptionHandler;
import org.springframework.core.annotation.Order;
import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.stereotype.Component;
import org.springframework.web.ErrorResponse;
import org.springframework.web.server.ServerWebExchange;

/**
 * Trata os erros que nascem no gateway (rota inexistente, serviço fora do ar, timeout) e os
 * devolve em Problem Details. Erros dos serviços passam direto: eles já vêm nesse formato.
 */
@Component
@Order(-2) // antes do handler padrão do Spring Boot
public class GatewayErrorHandler implements ErrorWebExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(GatewayErrorHandler.class);

    private final ProblemResponseWriter problems;

    public GatewayErrorHandler(ProblemResponseWriter problems) {
        this.problems = problems;
    }

    @Override
    public Mono<Void> handle(ServerWebExchange exchange, Throwable error) {
        if (isCausedBy(error, ConnectException.class) || isCausedBy(error, UnknownHostException.class)) {
            log.warn("Serviço de destino indisponível: {}", error.toString());
            return this.problems.write(exchange, HttpStatus.SERVICE_UNAVAILABLE, "upstream-unavailable",
                    "Serviço indisponível", "O serviço não está respondendo. Tente novamente em instantes.");
        }
        if (isCausedBy(error, TimeoutException.class)) {
            log.warn("Serviço de destino não respondeu a tempo: {}", error.toString());
            return this.problems.write(exchange, HttpStatus.GATEWAY_TIMEOUT, "upstream-timeout",
                    "Tempo de resposta esgotado", "O serviço demorou demais para responder.");
        }
        // Exceções do Spring que já carregam status e corpo (404 de rota, 405, 504 do gateway).
        if (error instanceof ErrorResponse response) {
            if (response.getStatusCode().is5xxServerError()) {
                log.warn("Erro do gateway: {}", error.toString());
            }
            return this.problems.write(exchange, response.getBody());
        }
        log.error("Erro não tratado no gateway", error);
        return this.problems.write(exchange, ProblemDetail.forStatusAndDetail(HttpStatus.INTERNAL_SERVER_ERROR,
                "Erro interno. Tente novamente em instantes."));
    }

    private static boolean isCausedBy(Throwable error, Class<? extends Throwable> type) {
        for (Throwable cause = error; cause != null; cause = cause.getCause()) {
            if (type.isInstance(cause)) {
                return true;
            }
        }
        return false;
    }
}
