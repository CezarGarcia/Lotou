package br.com.lotou.order.support;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

import com.networknt.schema.Error;
import com.networknt.schema.InputFormat;
import com.networknt.schema.Schema;
import com.networknt.schema.SchemaRegistry;
import com.networknt.schema.SpecificationVersion;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Confere mensagens contra os JSON Schemas de {@code contracts/} (na raiz do repositório): o que o
 * order-service publica precisa passar no contrato que os outros serviços leem.
 */
public final class Contracts {

    private static final Path ROOT = Path.of("../../contracts").toAbsolutePath().normalize();
    private static final SchemaRegistry REGISTRY = SchemaRegistry.withDefaultDialect(SpecificationVersion.DRAFT_2020_12);
    private static final Map<String, Schema> SCHEMAS = new ConcurrentHashMap<>();

    private Contracts() {
    }

    /** Falha o teste se a mensagem não passa no schema do tipo dela, naquele tópico. */
    public static void assertValid(String topic, String type, String envelope) {
        Schema schema = SCHEMAS.computeIfAbsent(topic + "/" + type, key -> load(topic, type));
        List<Error> errors = schema.validate(envelope, InputFormat.JSON);
        assertThat(errors).as("%s %s fora do contrato: %s", topic, type, envelope).isEmpty();
    }

    /** O exemplo de uma mensagem em {@code contracts/examples}, para testar a leitura. */
    public static String example(String topic, String type) {
        try {
            return Files.readString(ROOT.resolve("examples").resolve(topic).resolve(type + ".v1.json"));
        }
        catch (Exception ex) {
            throw new IllegalStateException("Exemplo não encontrado: " + topic + "/" + type, ex);
        }
    }

    private static Schema load(String topic, String type) {
        try {
            return REGISTRY.getSchema(Files.readString(ROOT.resolve(topic).resolve(type + ".v1.schema.json")),
                    InputFormat.JSON);
        }
        catch (Exception ex) {
            throw new IllegalStateException("Schema não encontrado: " + topic + "/" + type, ex);
        }
    }
}
