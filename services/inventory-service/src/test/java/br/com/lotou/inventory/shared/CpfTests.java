package br.com.lotou.inventory.shared;

import static org.assertj.core.api.Assertions.assertThat;

import br.com.lotou.inventory.config.InventoryProperties;
import br.com.lotou.inventory.support.Cpfs;
import org.junit.jupiter.api.Test;

class CpfTests {

    @Test
    void aceitaCpfValidoComOuSemPontuacao() {
        assertThat(Cpf.isValid("529.982.247-25")).isTrue();
        assertThat(Cpf.isValid("52998224725")).isTrue();
        assertThat(Cpf.isValid(Cpfs.next())).isTrue();
    }

    @Test
    void recusaDigitoErradoTamanhoErradoESequencia() {
        assertThat(Cpf.isValid("529.982.247-26")).isFalse();
        assertThat(Cpf.isValid("5299822472")).isFalse();
        assertThat(Cpf.isValid("111.111.111-11")).isFalse();
        assertThat(Cpf.isValid("")).isFalse();
        assertThat(Cpf.isValid(null)).isFalse();
    }

    @Test
    void hashNaoDependeDaPontuacaoEDependeDaChave() {
        var hasher = new CpfHasher(properties("chave-a"));

        String hash = hasher.hash("529.982.247-25");

        assertThat(hash).hasSize(64).doesNotContain("52998224725");
        assertThat(hasher.hash("52998224725")).isEqualTo(hash);
        assertThat(new CpfHasher(properties("chave-b")).hash("52998224725")).isNotEqualTo(hash);
    }

    @Test
    void uuidV7TemVersaoSeteECresceComOTempo() throws InterruptedException {
        var first = UuidV7.generate();
        Thread.sleep(2);
        var second = UuidV7.generate();

        assertThat(first.version()).isEqualTo(7);
        assertThat(first.variant()).isEqualTo(2);
        assertThat(second.toString()).isGreaterThan(first.toString());
    }

    private static InventoryProperties properties(String key) {
        return new InventoryProperties(InventoryProperties.Engine.REDIS,
                new InventoryProperties.Reservation(java.time.Duration.ofMinutes(10), 4, key),
                new InventoryProperties.Jobs(false),
                new InventoryProperties.Queue(100, java.time.Duration.ofMinutes(5), java.time.Duration.ofMinutes(30)));
    }
}
