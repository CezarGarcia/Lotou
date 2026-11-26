package br.com.lotou.order.messaging;

/** A mensagem não segue o contrato: tentar de novo não adianta, ela vai para a DLT. */
public class MalformedMessageException extends RuntimeException {

    public MalformedMessageException(String message) {
        super(message);
    }
}
