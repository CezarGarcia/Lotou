package br.com.lotou.order.pricing;

import java.util.List;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

import static org.assertj.core.api.Assertions.assertThat;

class PricingTests {

    @ParameterizedTest(name = "ingresso de {0} centavos paga {1} de taxa")
    @CsvSource({ "12000, 1200", "9995, 1000", "9994, 999", "5, 1", "4, 0", "0, 0" })
    void taxaEDezPorCentoArredondadaParaOCentavoMaisProximo(long unit, long fee) {
        assertThat(Pricing.feeOf(unit)).isEqualTo(fee);
    }

    @Test
    void taxaECalculadaIngressoAIngressoESomadaQuandoOCompradorPaga() {
        // 3 ingressos de 9.995: 1.000 de taxa cada (999,5 arredonda para cima), não 2.999 sobre o total.
        Quote quote = Pricing.quote(List.of(9_995L, 9_995L, 9_995L), ServiceFeePayer.BUYER, null);
        assertThat(quote.subtotalCents()).isEqualTo(29_985);
        assertThat(quote.serviceFeeCents()).isEqualTo(3_000);
        assertThat(quote.discountCents()).isZero();
        assertThat(quote.totalCents()).isEqualTo(32_985);
    }

    @Test
    void produtorQueAbsorveATaxaNaoMudaOTotalDoComprador() {
        Quote quote = Pricing.quote(List.of(12_000L), ServiceFeePayer.PRODUCER, null);
        assertThat(quote.serviceFeeCents()).isEqualTo(1_200);
        assertThat(quote.totalCents()).isEqualTo(12_000);
    }

    @Test
    void cupomPercentualArredondaParaBaixoEMNuncaTocaNaTaxa() {
        // 15% de 9.999 = 1.499,85: o comprador ganha 1.499, a taxa segue sobre o preço cheio.
        Quote quote = Pricing.quote(List.of(9_999L), ServiceFeePayer.BUYER, new Pricing.Discount.Percent(15));
        assertThat(quote.discountCents()).isEqualTo(1_499);
        assertThat(quote.serviceFeeCents()).isEqualTo(1_000);
        assertThat(quote.totalCents()).isEqualTo(9_999 - 1_499 + 1_000);
    }

    @Test
    void cupomDeValorNuncaDeixaOsIngressosAbaixoDeZero() {
        Quote quote = Pricing.quote(List.of(3_000L), ServiceFeePayer.BUYER, new Pricing.Discount.Amount(5_000));
        assertThat(quote.discountCents()).isEqualTo(3_000);
        assertThat(quote.totalCents()).isEqualTo(300); // sobra só a taxa
        Quote free = Pricing.quote(List.of(3_000L), ServiceFeePayer.PRODUCER, new Pricing.Discount.Percent(100));
        assertThat(free.totalCents()).isZero();
    }
}
