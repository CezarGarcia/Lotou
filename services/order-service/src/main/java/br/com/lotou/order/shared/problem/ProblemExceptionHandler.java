package br.com.lotou.order.shared.problem;

import java.net.URI;
import java.util.List;
import java.util.Map;

import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.SpanContext;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.ConstraintViolationException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.MediaType;
import org.springframework.http.ProblemDetail;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.security.core.AuthenticationException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.MissingRequestHeaderException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.context.request.ServletWebRequest;
import org.springframework.web.context.request.WebRequest;
import org.springframework.web.servlet.mvc.method.annotation.ResponseEntityExceptionHandler;

/**
 * Converte toda exceção em Problem Details (RFC 9457). É o único lugar do serviço que escreve uma
 * resposta de erro, então o contrato é um só, inclusive para 401 e 403.
 */
@RestControllerAdvice
public class ProblemExceptionHandler extends ResponseEntityExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(ProblemExceptionHandler.class);

    @ExceptionHandler(ProblemException.class)
    ResponseEntity<ProblemDetail> handleProblem(ProblemException ex, HttpServletRequest request) {
        return respond(ex.toProblemDetail(), request, new HttpHeaders());
    }

    @ExceptionHandler(AuthenticationException.class)
    ResponseEntity<ProblemDetail> handleUnauthenticated(AuthenticationException ex, HttpServletRequest request) {
        var headers = new HttpHeaders();
        headers.set(HttpHeaders.WWW_AUTHENTICATE, "Bearer");
        return respond(problem(HttpStatus.UNAUTHORIZED, "unauthorized", "Não autenticado",
                "Envie um token válido no cabeçalho Authorization."), request, headers);
    }

    @ExceptionHandler(AccessDeniedException.class)
    ResponseEntity<ProblemDetail> handleForbidden(AccessDeniedException ex, HttpServletRequest request) {
        return respond(Problems.forbidden().toProblemDetail(), request, new HttpHeaders());
    }

    @ExceptionHandler(ConstraintViolationException.class)
    ResponseEntity<ProblemDetail> handleConstraintViolation(ConstraintViolationException ex,
            HttpServletRequest request) {
        List<Map<String, String>> errors = ex.getConstraintViolations().stream()
                .map(violation -> Map.of("field", lastNode(violation.getPropertyPath().toString()), "message",
                        violation.getMessage()))
                .toList();
        return respond(validationProblem(errors), request, new HttpHeaders());
    }

    @ExceptionHandler(Exception.class)
    ResponseEntity<ProblemDetail> handleUnexpected(Exception ex, HttpServletRequest request) {
        // O detalhe vai para o log, nunca para o cliente.
        log.error("Erro não tratado", ex);
        return respond(ProblemDetail.forStatusAndDetail(HttpStatus.INTERNAL_SERVER_ERROR,
                "Erro interno. Tente novamente em instantes."), request, new HttpHeaders());
    }

    @Override
    protected ResponseEntity<Object> handleMethodArgumentNotValid(MethodArgumentNotValidException ex,
            HttpHeaders headers, HttpStatusCode status, WebRequest request) {
        List<Map<String, String>> errors = ex.getBindingResult().getFieldErrors().stream()
                .map(error -> Map.of("field", error.getField(), "message",
                        String.valueOf(error.getDefaultMessage())))
                .toList();
        return widen(respond(validationProblem(errors), servletRequest(request), headers));
    }

    @Override
    protected ResponseEntity<Object> handleServletRequestBindingException(
            org.springframework.web.bind.ServletRequestBindingException ex, HttpHeaders headers,
            HttpStatusCode status, WebRequest request) {
        if (ex instanceof MissingRequestHeaderException missing) {
            return widen(respond(validationProblem(List.of(Map.of("field", missing.getHeaderName(), "message",
                    "Cabeçalho obrigatório"))), servletRequest(request), headers));
        }
        return super.handleServletRequestBindingException(ex, headers, status, request);
    }

    /** Erros do próprio Spring MVC (404 de rota, 405, corpo malformado): mesmo formato. */
    @Override
    protected ResponseEntity<Object> handleExceptionInternal(Exception ex, Object body, HttpHeaders headers,
            HttpStatusCode status, WebRequest request) {
        ProblemDetail problem = body instanceof ProblemDetail detail ? detail
                : ProblemDetail.forStatus(status);
        return widen(respond(problem, servletRequest(request), headers));
    }

    private static ProblemDetail validationProblem(List<Map<String, String>> errors) {
        ProblemDetail problem = problem(HttpStatus.BAD_REQUEST, "validation-error", "Requisição inválida",
                "Um ou mais campos da requisição são inválidos.");
        problem.setProperty("errors", errors);
        return problem;
    }

    private static ProblemDetail problem(HttpStatus status, String slug, String title, String detail) {
        return new ProblemException(status, slug, title, detail).toProblemDetail();
    }

    private static ResponseEntity<ProblemDetail> respond(ProblemDetail problem, HttpServletRequest request,
            HttpHeaders headers) {
        problem.setInstance(URI.create(request.getRequestURI()));
        SpanContext span = Span.current().getSpanContext();
        if (span.isValid()) {
            problem.setProperty("traceId", span.getTraceId());
        }
        return ResponseEntity.status(problem.getStatus())
                .headers(headers)
                .contentType(MediaType.APPLICATION_PROBLEM_JSON)
                .body(problem);
    }

    private static HttpServletRequest servletRequest(WebRequest request) {
        return ((ServletWebRequest) request).getRequest();
    }

    private static String lastNode(String path) {
        return path.substring(path.lastIndexOf('.') + 1);
    }

    @SuppressWarnings({"unchecked", "rawtypes"})
    private static ResponseEntity<Object> widen(ResponseEntity<ProblemDetail> response) {
        return (ResponseEntity) response;
    }
}
