package br.com.lotou.inventory.reservation;

import static br.com.lotou.inventory.support.Fixtures.cadeiras;
import static br.com.lotou.inventory.support.Fixtures.lot;
import static br.com.lotou.inventory.support.Fixtures.pista;
import static org.hamcrest.Matchers.contains;
import static org.hamcrest.Matchers.hasSize;
import static org.hamcrest.Matchers.matchesPattern;
import static org.hamcrest.Matchers.nullValue;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.UUID;

import br.com.lotou.inventory.catalog.CatalogShow;
import br.com.lotou.inventory.support.Cpfs;
import br.com.lotou.inventory.support.Fixtures;
import br.com.lotou.inventory.support.IntegrationTest;
import org.junit.jupiter.api.Test;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.MediaType;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.test.web.servlet.request.RequestPostProcessor;

/** O contrato HTTP do inventory: reservas, disponibilidade, erros e regras de acesso. */
@IntegrationTest
class ReservationApiTests {

    private static final MediaType PROBLEM = MediaType.APPLICATION_PROBLEM_JSON;

    @Autowired
    private MockMvc mvc;

    @Autowired
    private Fixtures fixtures;

    private static RequestPostProcessor user(String subject, String role) {
        return jwt().jwt(token -> token.subject(subject)).authorities(new SimpleGrantedAuthority("ROLE_" + role));
    }

    private static RequestPostProcessor buyer(String subject) {
        return user(subject, "buyer");
    }

    private static MockHttpServletRequestBuilder reserve(String body) {
        return post("/v1/reservations")
                .header("Idempotency-Key", UUID.randomUUID().toString())
                .contentType(MediaType.APPLICATION_JSON)
                .content(body);
    }

    private static String pistaBody(CatalogShow show, int quantity) {
        return """
                {"showId": "%s", "sectorId": "%s", "quantity": %d, "cpf": "%s"}
                """.formatted(show.id(), show.sectors().getFirst().id(), quantity, Cpfs.next());
    }

    @Test
    void reservaNaPistaDevolve201ComLocationPrazoEPrecoEmCentavos() throws Exception {
        CatalogShow show = this.fixtures.onSale(pista(lot("1º lote", 18_000, 10)));

        this.mvc.perform(reserve(pistaBody(show, 2)).with(buyer("ana")))
                .andExpect(status().isCreated())
                .andExpect(header().string("Location", matchesPattern("/v1/reservations/[0-9a-f-]{36}")))
                .andExpect(header().doesNotExist("Idempotent-Replayed"))
                .andExpect(jsonPath("$.id", matchesPattern("[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f-]+")))
                .andExpect(jsonPath("$.status").value("HELD"))
                .andExpect(jsonPath("$.sectorName").value("Pista"))
                .andExpect(jsonPath("$.quantity").value(2))
                .andExpect(jsonPath("$.totalCents").value(36_000))
                .andExpect(jsonPath("$.expiresAt").isNotEmpty())
                .andExpect(jsonPath("$.items", hasSize(2)))
                .andExpect(jsonPath("$.items[0].lotName").value("1º lote"))
                .andExpect(jsonPath("$.items[0].unitPriceCents").value(18_000))
                .andExpect(jsonPath("$.items[0].seat").value(nullValue()))
                // O CPF e o hash dele não saem na resposta.
                .andExpect(jsonPath("$.cpf").doesNotExist())
                .andExpect(jsonPath("$.cpfHash").doesNotExist());
    }

    @Test
    void reservaDeCadeirasDevolveUmItemPorCadeira() throws Exception {
        var setor = cadeiras(1, 10, 30_000);
        CatalogShow show = this.fixtures.onSale(setor);

        this.mvc.perform(reserve("""
                {"showId": "%s", "sectorId": "%s", "seats": ["A-2", "A-1"], "cpf": "%s"}
                """.formatted(show.id(), setor.id(), Cpfs.next())).with(buyer("ana")))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.quantity").value(2))
                .andExpect(jsonPath("$.totalCents").value(60_000))
                .andExpect(jsonPath("$.items[*].seat", contains("A-1", "A-2")));
    }

    @Test
    void repeticaoComAMesmaChaveDevolveAMesmaReserva() throws Exception {
        CatalogShow show = this.fixtures.onSale(pista(lot("Lote único", 12_000, 10)));
        String key = UUID.randomUUID().toString();
        String body = pistaBody(show, 1);
        var request = post("/v1/reservations").header("Idempotency-Key", key)
                .contentType(MediaType.APPLICATION_JSON).content(body).with(buyer("ana"));

        String first = this.mvc.perform(request).andExpect(status().isCreated())
                .andReturn().getResponse().getContentAsString();
        this.mvc.perform(request)
                .andExpect(status().isCreated())
                .andExpect(header().string("Idempotent-Replayed", "true"))
                .andExpect(content().json(first));

        // A mesma chave com outro pedido é erro do cliente.
        this.mvc.perform(post("/v1/reservations").header("Idempotency-Key", key)
                .contentType(MediaType.APPLICATION_JSON).content(pistaBody(show, 2)).with(buyer("ana")))
                .andExpect(status().isUnprocessableContent())
                .andExpect(jsonPath("$.type").value("urn:lotou:problem:idempotency-key-reused"));
    }

    @Test
    void esgotadoResponde409EmProblemDetails() throws Exception {
        CatalogShow show = this.fixtures.onSale(pista(lot("Lote único", 12_000, 2)));
        this.mvc.perform(reserve(pistaBody(show, 1)).with(buyer("ana"))).andExpect(status().isCreated());

        this.mvc.perform(reserve(pistaBody(show, 2)).with(buyer("bia")))
                .andExpect(status().isConflict())
                .andExpect(content().contentTypeCompatibleWith(PROBLEM))
                .andExpect(jsonPath("$.type").value("urn:lotou:problem:insufficient-stock"))
                .andExpect(jsonPath("$.available").value(1))
                .andExpect(jsonPath("$.instance").value("/v1/reservations"));

        this.mvc.perform(reserve(pistaBody(show, 1)).with(buyer("bia"))).andExpect(status().isCreated());
        this.mvc.perform(reserve(pistaBody(show, 1)).with(buyer("caio")))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.type").value("urn:lotou:problem:sold-out"))
                .andExpect(jsonPath("$.title").value("Ingressos esgotados"));
    }

    @Test
    void cadeiraOcupadaResponde409ComAsCadeirasEmConflito() throws Exception {
        var setor = cadeiras(1, 10, 30_000);
        CatalogShow show = this.fixtures.onSale(setor);
        String body = """
                {"showId": "%s", "sectorId": "%s", "seats": ["A-1", "A-2"], "cpf": "%s"}
                """;
        this.mvc.perform(reserve(body.formatted(show.id(), setor.id(), Cpfs.next())).with(buyer("ana")))
                .andExpect(status().isCreated());

        this.mvc.perform(reserve("""
                {"showId": "%s", "sectorId": "%s", "seats": ["A-2", "A-3"], "cpf": "%s"}
                """.formatted(show.id(), setor.id(), Cpfs.next())).with(buyer("bia")))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.type").value("urn:lotou:problem:seat-unavailable"))
                .andExpect(jsonPath("$.seats", contains("A-2")));
    }

    @Test
    void limitePorCpfResponde422ComOQueResta() throws Exception {
        CatalogShow show = this.fixtures.onSale(pista(lot("Lote único", 12_000, 50)));
        String cpf = Cpfs.next();
        String body = """
                {"showId": "%s", "sectorId": "%s", "quantity": 3, "cpf": "%s"}
                """.formatted(show.id(), show.sectors().getFirst().id(), cpf);

        this.mvc.perform(reserve(body).with(buyer("ana"))).andExpect(status().isCreated());
        // O limite é do CPF, não da conta: outra conta com o mesmo CPF também é barrada.
        this.mvc.perform(reserve(body).with(buyer("outra-conta")))
                .andExpect(status().isUnprocessableContent())
                .andExpect(jsonPath("$.type").value("urn:lotou:problem:purchase-limit-exceeded"))
                .andExpect(jsonPath("$.remaining").value(1));
    }

    @Test
    void validaCorpoCpfECabecalho() throws Exception {
        CatalogShow show = this.fixtures.onSale(pista(lot("Lote único", 12_000, 10)));

        this.mvc.perform(reserve("""
                {"sectorId": "%s", "quantity": 9, "cpf": ""}
                """.formatted(show.sectors().getFirst().id())).with(buyer("ana")))
                .andExpect(status().isBadRequest())
                .andExpect(content().contentTypeCompatibleWith(PROBLEM))
                .andExpect(jsonPath("$.type").value("urn:lotou:problem:validation-error"))
                .andExpect(jsonPath("$.errors[*].field", org.hamcrest.Matchers.containsInAnyOrder("showId", "quantity", "cpf")));

        this.mvc.perform(reserve("""
                {"showId": "%s", "sectorId": "%s", "quantity": 1, "cpf": "123.456.789-00"}
                """.formatted(show.id(), show.sectors().getFirst().id())).with(buyer("ana")))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.errors[0].field").value("cpf"))
                .andExpect(jsonPath("$.errors[0].message").value("CPF inválido"));

        this.mvc.perform(post("/v1/reservations").contentType(MediaType.APPLICATION_JSON)
                .content(pistaBody(show, 1)).with(buyer("ana")))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.errors[0].field").value("Idempotency-Key"));

        this.mvc.perform(reserve("{ isto não é json").with(buyer("ana")))
                .andExpect(status().isBadRequest())
                .andExpect(content().contentTypeCompatibleWith(PROBLEM));
    }

    @Test
    void soOCompradorReservaESoODonoVeAReserva() throws Exception {
        CatalogShow show = this.fixtures.onSale(pista(lot("Lote único", 12_000, 10)));

        this.mvc.perform(reserve(pistaBody(show, 1)))
                .andExpect(status().isUnauthorized())
                .andExpect(content().contentTypeCompatibleWith(PROBLEM))
                .andExpect(header().string("WWW-Authenticate", "Bearer"))
                .andExpect(jsonPath("$.type").value("urn:lotou:problem:unauthorized"));
        this.mvc.perform(reserve(pistaBody(show, 1)).with(user("caio", "producer")))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.type").value("urn:lotou:problem:forbidden"));

        String location = this.mvc.perform(reserve(pistaBody(show, 1)).with(buyer("ana")))
                .andExpect(status().isCreated()).andReturn().getResponse().getHeader("Location");
        this.mvc.perform(get(location).with(buyer("ana"))).andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("HELD"));
        this.mvc.perform(get(location).with(buyer("bia"))).andExpect(status().isNotFound())
                .andExpect(jsonPath("$.type").value("urn:lotou:problem:not-found"));
    }

    @Test
    void apiInternaSoAceitaContaDeServico() throws Exception {
        CatalogShow show = this.fixtures.onSale(pista(lot("Lote único", 12_000, 10)));
        String location = this.mvc.perform(reserve(pistaBody(show, 2)).with(buyer("ana")))
                .andExpect(status().isCreated()).andReturn().getResponse().getHeader("Location");
        String internal = "/internal" + location;

        this.mvc.perform(get(internal)).andExpect(status().isUnauthorized());
        this.mvc.perform(get(internal).with(buyer("ana"))).andExpect(status().isForbidden());
        this.mvc.perform(post(internal + "/confirm").with(buyer("ana"))).andExpect(status().isForbidden());

        var service = user("service-account-order-service", "service");
        this.mvc.perform(get(internal).with(service))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.buyerId").value("ana"))
                .andExpect(jsonPath("$.reservation.status").value("HELD"))
                .andExpect(jsonPath("$.reservation.totalCents").value(24_000));
        this.mvc.perform(post(internal + "/confirm").with(service))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.reservation.status").value("CONFIRMED"));
        this.mvc.perform(post(internal + "/release").with(service))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.type").value("urn:lotou:problem:reservation-not-held"))
                .andExpect(jsonPath("$.status").value("CONFIRMED"));
    }

    @Test
    void disponibilidadeEhPublicaEMostraOLoteEmVenda() throws Exception {
        var pista = pista(lot("1º lote", 10_000, 2), lot("2º lote", 14_000, 5));
        var setor = cadeiras(1, 3, 30_000);
        CatalogShow show = this.fixtures.onSale(pista, setor);
        this.mvc.perform(reserve(pistaBody(show, 2)).with(buyer("ana"))).andExpect(status().isCreated());
        this.mvc.perform(reserve("""
                {"showId": "%s", "sectorId": "%s", "seats": ["A-2"], "cpf": "%s"}
                """.formatted(show.id(), setor.id(), Cpfs.next())).with(buyer("ana")))
                .andExpect(status().isCreated());

        this.mvc.perform(get("/v1/availability/" + show.id()))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.sectors", hasSize(2)))
                // O 1º lote esgotou: o setor mostra o 2º, com o preço dele.
                .andExpect(jsonPath("$.sectors[0].name").value("Pista"))
                .andExpect(jsonPath("$.sectors[0].sale").value("ON_SALE"))
                .andExpect(jsonPath("$.sectors[0].lot.name").value("2º lote"))
                .andExpect(jsonPath("$.sectors[0].lot.priceCents").value(14_000))
                .andExpect(jsonPath("$.sectors[0].available").value(5))
                .andExpect(jsonPath("$.sectors[1].kind").value("RESERVED_SEATING"))
                .andExpect(jsonPath("$.sectors[1].available").value(2));

        this.mvc.perform(get("/v1/availability/%s/sectors/%s/seats".formatted(show.id(), setor.id())))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.seats[*].label", contains("A-1", "A-2", "A-3")))
                .andExpect(jsonPath("$.seats[*].available", contains(true, false, true)));

        this.mvc.perform(get("/v1/availability/" + UUID.randomUUID()))
                .andExpect(status().isNotFound())
                .andExpect(content().contentTypeCompatibleWith(PROBLEM));
    }

    @Test
    void rotaNaoListadaEhFechadaPorPadrao() throws Exception {
        this.mvc.perform(get("/v1/qualquer-coisa").with(buyer("ana"))).andExpect(status().isForbidden());
        this.mvc.perform(get("/actuator/health/readiness")).andExpect(status().isOk());
        this.mvc.perform(get("/actuator/env").with(buyer("ana"))).andExpect(status().isForbidden());
    }
}
