package br.com.lotou.order.support;

import java.util.List;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;

import br.com.lotou.order.payment.PaymentGateway;

/** Um pagamento que o teste controla: aprova ou recusa, e registra o que foi pedido. */
public class ControllablePaymentGateway implements PaymentGateway {

    private volatile Result next = Result.AUTHORIZED;
    private volatile Runnable onAuthorize = () -> { };
    private final List<UUID> authorizations = new CopyOnWriteArrayList<>();
    private final List<UUID> voided = new CopyOnWriteArrayList<>();

    public void declineNext() {
        this.next = Result.DECLINED;
    }

    /** Roda {@code action} durante a próxima autorização: é o "meio do checkout" dos testes. */
    public void onAuthorize(Runnable action) {
        this.onAuthorize = action;
    }

    public void reset() {
        this.next = Result.AUTHORIZED;
        this.onAuthorize = () -> { };
        this.authorizations.clear();
        this.voided.clear();
    }

    @Override
    public Result authorize(UUID orderId, long amountCents) {
        this.authorizations.add(orderId);
        this.onAuthorize.run();
        return this.next;
    }

    @Override
    public void voidAuthorization(UUID orderId) {
        this.voided.add(orderId);
    }

    public long authorizationsOf(UUID orderId) {
        return this.authorizations.stream().filter(orderId::equals).count();
    }

    public List<UUID> voided() {
        return List.copyOf(this.voided);
    }
}
