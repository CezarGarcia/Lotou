package br.com.lotou.order.shared.problem;

import org.springframework.http.HttpStatus;

/** Problemas usados por mais de um módulo. */
public final class Problems {

    private Problems() {
    }

    public static ProblemException notFound(String resource) {
        return new ProblemException(HttpStatus.NOT_FOUND, "not-found", "Recurso não encontrado",
                resource + " não encontrado.");
    }

    public static ProblemException forbidden() {
        return new ProblemException(HttpStatus.FORBIDDEN, "forbidden", "Acesso negado",
                "Seu usuário não tem permissão para esta operação.");
    }

    public static ProblemException invalidTransition(String entity, Enum<?> from, Enum<?> to) {
        return new ProblemException(HttpStatus.CONFLICT, "invalid-state-transition",
                "Transição de estado inválida", "%s em %s não pode ir para %s.".formatted(entity, from, to));
    }
}
