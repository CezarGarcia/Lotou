package br.com.lotou.gateway.security;

/** Papéis do realm {@code lotou} no Keycloak (ADR 19). */
public final class Roles {

    public static final String BUYER = "buyer";
    public static final String PRODUCER = "producer";
    public static final String GATE_STAFF = "gate-staff";

    private Roles() {
    }
}
