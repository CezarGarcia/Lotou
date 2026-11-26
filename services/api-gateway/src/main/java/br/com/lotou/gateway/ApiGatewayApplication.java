package br.com.lotou.gateway;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * Porta de entrada do Lotou: roteia para os serviços e valida o JWT. As rotas ficam em
 * {@code application.yml}; as regras de acesso, em {@code SecurityConfig}.
 */
@SpringBootApplication
public class ApiGatewayApplication {

    public static void main(String[] args) {
        SpringApplication.run(ApiGatewayApplication.class, args);
    }
}
