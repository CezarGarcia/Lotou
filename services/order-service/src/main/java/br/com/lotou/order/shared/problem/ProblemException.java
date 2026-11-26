package br.com.lotou.order.shared.problem;

import java.net.URI;
import java.util.LinkedHashMap;
import java.util.Map;

import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;

/**
 * Erro de API com tipo próprio. O {@link ProblemExceptionHandler} o converte em Problem Details
 * (RFC 9457), com {@code type} no formato {@code urn:lotou:problem:<tipo>}.
 */
public class ProblemException extends RuntimeException {

    private static final String TYPE_PREFIX = "urn:lotou:problem:";

    private final HttpStatus status;
    private final String slug;
    private final String title;
    private final Map<String, Object> properties = new LinkedHashMap<>();

    public ProblemException(HttpStatus status, String slug, String title, String detail) {
        super(detail);
        this.status = status;
        this.slug = slug;
        this.title = title;
    }

    /** Acrescenta um campo próprio ao problema, ex.: quantos ingressos ainda restam. */
    public ProblemException with(String name, Object value) {
        this.properties.put(name, value);
        return this;
    }

    public HttpStatus status() {
        return this.status;
    }

    public String slug() {
        return this.slug;
    }

    public ProblemDetail toProblemDetail() {
        ProblemDetail problem = ProblemDetail.forStatusAndDetail(this.status, getMessage());
        problem.setType(URI.create(TYPE_PREFIX + this.slug));
        problem.setTitle(this.title);
        this.properties.forEach(problem::setProperty);
        return problem;
    }
}
