package br.com.lotou.inventory.shared.security;

import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpMethod;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.config.annotation.web.configurers.AbstractHttpConfigurer;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationConverter;
import org.springframework.security.web.AuthenticationEntryPoint;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.access.AccessDeniedHandler;
import org.springframework.web.servlet.HandlerExceptionResolver;

/**
 * Regras de acesso do serviço.
 *
 * <p>O gateway já valida o JWT, mas o serviço valida de novo (ADR 21): assinatura, emissor,
 * audiência e validade. Tudo é fechado por padrão: uma rota nova só abre se for listada aqui.
 */
@Configuration(proxyBeanMethods = false)
@EnableWebSecurity
public class SecurityConfig {

    @Bean
    SecurityFilterChain securityFilterChain(HttpSecurity http,
            @Qualifier("handlerExceptionResolver") HandlerExceptionResolver resolver) throws Exception {
        // 401 e 403 passam pelo mesmo handler dos outros erros, para sair em Problem Details.
        AuthenticationEntryPoint unauthorized = (request, response, ex) ->
                resolver.resolveException(request, response, null, ex);
        AccessDeniedHandler forbidden = (request, response, ex) ->
                resolver.resolveException(request, response, null, ex);

        return http
                // API sem estado, autenticada por token no cabeçalho: sem sessão nem cookie.
                .csrf(AbstractHttpConfigurer::disable)
                .sessionManagement(session -> session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .authorizeHttpRequests(requests -> requests
                        .requestMatchers("/actuator/health/**").permitAll()
                        // Disponibilidade e mapa de assentos: a loja mostra sem login.
                        .requestMatchers(HttpMethod.GET, "/v1/availability/**").permitAll()
                        .requestMatchers("/v1/reservations/**").hasRole(Roles.BUYER)
                        .requestMatchers("/v1/lots/**").hasRole(Roles.PRODUCER)
                        // Chamadas de outros serviços do Lotou; não passam pelo gateway.
                        .requestMatchers("/internal/**").hasRole(Roles.SERVICE)
                        .anyRequest().denyAll())
                .oauth2ResourceServer(oauth2 -> oauth2
                        .jwt(jwt -> jwt.jwtAuthenticationConverter(jwtAuthenticationConverter()))
                        .authenticationEntryPoint(unauthorized)
                        .accessDeniedHandler(forbidden))
                .exceptionHandling(handling -> handling
                        .authenticationEntryPoint(unauthorized)
                        .accessDeniedHandler(forbidden))
                .build();
    }

    private static JwtAuthenticationConverter jwtAuthenticationConverter() {
        var converter = new JwtAuthenticationConverter();
        converter.setJwtGrantedAuthoritiesConverter(new KeycloakRealmRolesConverter());
        return converter;
    }
}
