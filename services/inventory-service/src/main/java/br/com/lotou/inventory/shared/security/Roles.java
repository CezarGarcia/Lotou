package br.com.lotou.inventory.shared.security;

/** Papéis do realm {@code lotou} no Keycloak (ADR 19). */
public final class Roles {

    public static final String BUYER = "buyer";
    public static final String PRODUCER = "producer";
    /** Conta de serviço: chamada feita por outro serviço do Lotou, sem usuário. */
    public static final String SERVICE = "service";

    private Roles() {
    }
}
