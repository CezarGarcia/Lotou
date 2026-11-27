package br.com.lotou.order.shared.security;

/** Papéis do realm {@code lotou} no Keycloak (ADR 19). */
public final class Roles {

    public static final String BUYER = "buyer";
    public static final String PRODUCER = "producer";

    private Roles() {
    }
}
