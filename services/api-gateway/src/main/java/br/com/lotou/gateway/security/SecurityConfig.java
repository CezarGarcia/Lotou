package br.com.lotou.gateway.security;

import br.com.lotou.gateway.problem.ProblemResponseWriter;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.security.config.annotation.web.reactive.EnableWebFluxSecurity;
import org.springframework.security.config.web.server.ServerHttpSecurity;
import org.springframework.security.oauth2.server.resource.authentication.ReactiveJwtAuthenticationConverter;
import org.springframework.security.oauth2.server.resource.authentication.ReactiveJwtGrantedAuthoritiesConverterAdapter;
import org.springframework.security.web.server.SecurityWebFilterChain;
import org.springframework.security.web.server.ServerAuthenticationEntryPoint;
import org.springframework.security.web.server.authorization.ServerAccessDeniedHandler;
import org.springframework.security.web.server.context.NoOpServerSecurityContextRepository;
import org.springframework.security.web.server.savedrequest.NoOpServerRequestCache;

/**
 * Regras de acesso do gateway.
 *
 * <p>O gateway é um resource server OAuth 2.0: valida a assinatura do JWT com a chave pública do
 * realm, o emissor, a audiência e a validade, sem chamar o Keycloak a cada requisição. Ele é a
 * primeira barreira; cada serviço valida o token de novo (ADR 21).
 *
 * <p>Tudo é fechado por padrão: uma rota nova só fica pública se for listada aqui. As APIs
 * internas dos serviços ({@code /internal/**}) não têm rota no gateway.
 */
@Configuration(proxyBeanMethods = false)
@EnableWebFluxSecurity
public class SecurityConfig {

    /** Catálogo de shows e locais, servido pelo event-service. */
    private static final String[] CATALOG = {"/api/v1/shows/**", "/api/v1/venues/**"};

    @Bean
    SecurityWebFilterChain securityWebFilterChain(ServerHttpSecurity http, ProblemResponseWriter problems) {
        ServerAuthenticationEntryPoint unauthorized = (exchange, ex) -> {
            exchange.getResponse().getHeaders().set("WWW-Authenticate", "Bearer");
            return problems.write(exchange, HttpStatus.UNAUTHORIZED, "unauthorized", "Não autenticado",
                    "Envie um token válido no cabeçalho Authorization.");
        };
        ServerAccessDeniedHandler forbidden = (exchange, ex) ->
                problems.write(exchange, HttpStatus.FORBIDDEN, "forbidden", "Acesso negado",
                        "Seu usuário não tem permissão para esta operação.");

        return http
                // API sem estado, autenticada por token no cabeçalho: não há sessão nem cookie
                // para o CSRF explorar.
                .csrf(ServerHttpSecurity.CsrfSpec::disable)
                .httpBasic(ServerHttpSecurity.HttpBasicSpec::disable)
                .formLogin(ServerHttpSecurity.FormLoginSpec::disable)
                .logout(ServerHttpSecurity.LogoutSpec::disable)
                .securityContextRepository(NoOpServerSecurityContextRepository.getInstance())
                .requestCache(cache -> cache.requestCache(NoOpServerRequestCache.getInstance()))
                .authorizeExchange(exchange -> exchange
                        .pathMatchers("/actuator/health/**").permitAll()
                        // A loja navega sem login: buscar e ver um show é público.
                        .pathMatchers(HttpMethod.GET, CATALOG).permitAll()
                        // Cadastrar e alterar shows e locais é do produtor.
                        .pathMatchers(CATALOG).hasRole(Roles.PRODUCER)
                        // O que está à venda agora (lote, preço e cadeiras livres) também é público.
                        .pathMatchers(HttpMethod.GET, "/api/v1/availability/**").permitAll()
                        // Reservar e comprar é do comprador.
                        .pathMatchers("/api/v1/reservations/**", "/api/v1/orders/**", "/api/v1/queue/**")
                        .hasRole(Roles.BUYER)
                        // Pausar e retomar lote é do produtor.
                        .pathMatchers("/api/v1/lots/**").hasRole(Roles.PRODUCER)
                        .anyExchange().authenticated())
                .oauth2ResourceServer(oauth2 -> oauth2
                        .jwt(jwt -> jwt.jwtAuthenticationConverter(jwtAuthenticationConverter()))
                        .authenticationEntryPoint(unauthorized)
                        .accessDeniedHandler(forbidden))
                .exceptionHandling(handling -> handling
                        .authenticationEntryPoint(unauthorized)
                        .accessDeniedHandler(forbidden))
                .build();
    }

    private static ReactiveJwtAuthenticationConverter jwtAuthenticationConverter() {
        var converter = new ReactiveJwtAuthenticationConverter();
        converter.setJwtGrantedAuthoritiesConverter(
                new ReactiveJwtGrantedAuthoritiesConverterAdapter(new KeycloakRealmRolesConverter()));
        return converter;
    }
}
