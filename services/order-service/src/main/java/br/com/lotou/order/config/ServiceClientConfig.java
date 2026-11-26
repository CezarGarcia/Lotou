package br.com.lotou.order.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.authentication.AnonymousAuthenticationToken;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.authority.AuthorityUtils;
import org.springframework.security.oauth2.client.AuthorizedClientServiceOAuth2AuthorizedClientManager;
import org.springframework.security.oauth2.client.OAuth2AuthorizedClientManager;
import org.springframework.security.oauth2.client.OAuth2AuthorizedClientService;
import org.springframework.security.oauth2.client.registration.ClientRegistrationRepository;
import org.springframework.security.oauth2.client.web.client.OAuth2ClientHttpRequestInterceptor;

/**
 * Cliente HTTP para chamar outros serviços do Lotou.
 *
 * <p>Cada chamada leva o token da conta de serviço deste serviço, obtido no Keycloak por client
 * credentials (ADR 21). O Spring Security guarda o token e só busca outro quando ele expira.
 */
@Configuration(proxyBeanMethods = false)
public class ServiceClientConfig {

    /** Nome do registro em {@code spring.security.oauth2.client.registration}. */
    private static final String REGISTRATION = "lotou";

    /** O token é do serviço, não de quem fez a requisição: o "usuário" é sempre o mesmo. */
    private static final Authentication SERVICE_PRINCIPAL = new AnonymousAuthenticationToken("service",
            "order-service", AuthorityUtils.createAuthorityList("ROLE_SERVICE"));

    /** Funciona fora de uma requisição HTTP, que é onde os jobs rodam. */
    @Bean
    OAuth2AuthorizedClientManager authorizedClientManager(ClientRegistrationRepository registrations,
            OAuth2AuthorizedClientService clients) {
        return new AuthorizedClientServiceOAuth2AuthorizedClientManager(registrations, clients);
    }

    /** Acrescenta o token da conta de serviço a cada chamada. */
    @Bean
    OAuth2ClientHttpRequestInterceptor serviceTokenInterceptor(OAuth2AuthorizedClientManager authorizedClientManager) {
        var oauth2 = new OAuth2ClientHttpRequestInterceptor(authorizedClientManager);
        oauth2.setClientRegistrationIdResolver(request -> REGISTRATION);
        oauth2.setPrincipalResolver(request -> SERVICE_PRINCIPAL);
        return oauth2;
    }
}
