import { Observable } from 'rxjs';
import { ApiError, problemToApiError } from './problem';

/** Uma mensagem de um fluxo `text/event-stream`. */
export interface SseMessage {
  /** Nome do evento; `message` quando o servidor não informa. */
  event: string;
  data: string;
  /** Último `id:` recebido, se o servidor numera os eventos. */
  id?: string;
}

/**
 * Parser incremental de Server-Sent Events, conforme a especificação do HTML.
 * Recebe o texto em pedaços do tamanho que a rede entregar (uma linha pode vir
 * partida entre dois pedaços) e devolve as mensagens completas.
 *
 * - `event:`, `data:` (várias linhas viram uma, separadas por `\n`), `id:` e `retry:`
 * - linhas que começam com `:` são comentários; o servidor as usa como heartbeat
 * - a mensagem é entregue na linha em branco; sem `data:`, não há mensagem
 */
export class SseParser {
  /** Espera do servidor, em ms, para reconectar (`retry:`). */
  retryMs?: number;
  /** Valor para o cabeçalho `Last-Event-ID` na reconexão. */
  lastEventId = '';

  private buffer = '';
  private started = false;
  private event = '';
  private data: string[] = [];

  push(chunk: string): SseMessage[] {
    let text = this.buffer + chunk;
    if (!this.started && text.length > 0) {
      this.started = true;
      text = text.replace(/^﻿/, '');
    }

    const messages: SseMessage[] = [];
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (char !== '\n' && char !== '\r') {
        continue;
      }
      // Um \r no fim do pedaço pode ser a metade de um \r\n: espera o próximo.
      if (char === '\r' && i === text.length - 1) {
        break;
      }
      const message = this.line(text.slice(start, i));
      if (message) {
        messages.push(message);
      }
      if (char === '\r' && text[i + 1] === '\n') {
        i++;
      }
      start = i + 1;
    }
    this.buffer = text.slice(start);
    return messages;
  }

  private line(line: string): SseMessage | null {
    if (line === '') {
      return this.dispatch();
    }
    if (line.startsWith(':')) {
      return null;
    }
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) {
      value = value.slice(1);
    }
    switch (field) {
      case 'event':
        this.event = value;
        break;
      case 'data':
        this.data.push(value);
        break;
      case 'id':
        if (!value.includes('\0')) {
          this.lastEventId = value;
        }
        break;
      case 'retry':
        if (/^\d+$/.test(value)) {
          this.retryMs = Number(value);
        }
        break;
    }
    return null;
  }

  private dispatch(): SseMessage | null {
    const message: SseMessage | null =
      this.data.length === 0
        ? null
        : {
            event: this.event || 'message',
            data: this.data.join('\n'),
            ...(this.lastEventId ? { id: this.lastEventId } : {}),
          };
    this.event = '';
    this.data = [];
    return message;
  }
}

/** Falha definitiva ao abrir o fluxo: o servidor recusou (401, 403, 404...). */
export class SseError extends Error {
  constructor(readonly apiError: ApiError) {
    super(apiError.message);
    this.name = 'SseError';
  }
}

export interface SseOptions {
  /** Cabeçalhos de cada conexão. É chamado de novo a cada reconexão: o token pode ter sido renovado. */
  headers?: () => Record<string, string> | Promise<Record<string, string>>;
  /** Primeira espera antes de reconectar, em ms; dobra a cada falha seguida. */
  initialDelayMs?: number;
  maxDelayMs?: number;
  /** Para os testes. */
  fetch?: typeof fetch;
  random?: () => number;
}

/** Status em que vale reconectar: o problema pode passar sozinho. */
const RETRYABLE = (status: number) => status === 408 || status === 429 || status >= 500;

/**
 * Lê um fluxo de Server-Sent Events com `fetch`, como um Observable.
 *
 * O `EventSource` do navegador não envia cabeçalhos, e a fila virtual precisa do
 * token do comprador. Aqui cada conexão monta os próprios cabeçalhos; se a
 * conexão cai ou o servidor encerra o fluxo, reconecta com espera exponencial
 * (com variação aleatória, para milhares de navegadores não voltarem juntos).
 * Um 4xx encerra o Observable com `SseError`. Cancelar a inscrição aborta a
 * requisição.
 *
 * O `fetch` já é instrumentado pelo OpenTelemetry: a conexão vira um span e
 * leva o `traceparent` como qualquer chamada à API.
 */
export function readSse(url: string, options: SseOptions = {}): Observable<SseMessage> {
  const initialDelay = options.initialDelayMs ?? 1_000;
  const maxDelay = options.maxDelayMs ?? 30_000;
  const random = options.random ?? Math.random;

  return new Observable<SseMessage>((subscriber) => {
    const controller = new AbortController();
    const fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
    let failures = 0;
    let lastEventId = '';
    let serverRetryMs: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const reconnect = (retryAfterMs?: number) => {
      if (subscriber.closed) {
        return;
      }
      const base = serverRetryMs ?? initialDelay;
      const backoff = Math.min(maxDelay, base * 2 ** failures);
      const delay = Math.max(retryAfterMs ?? 0, backoff * (0.8 + random() * 0.4));
      failures++;
      timer = setTimeout(() => void connect(), delay);
    };

    const connect = async () => {
      let retryAfterMs: number | undefined;
      try {
        const headers: Record<string, string> = {
          Accept: 'text/event-stream',
          ...(await options.headers?.()),
        };
        if (lastEventId) {
          headers['Last-Event-ID'] = lastEventId;
        }
        const response = await fetchFn(url, {
          headers,
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          const error = problemToApiError(
            response.status,
            await response.json().catch(() => null),
            response.headers,
          );
          if (!RETRYABLE(response.status)) {
            subscriber.error(new SseError(error));
            return;
          }
          retryAfterMs = (error.retryAfterSeconds ?? 0) * 1000;
        } else if (!response.headers.get('Content-Type')?.includes('text/event-stream')) {
          // Uma rota errada pode cair no index.html com 200: isso não é um fluxo.
          subscriber.error(
            new SseError({
              status: response.status,
              message: 'A resposta não é um fluxo de eventos.',
            }),
          );
          return;
        } else {
          failures = 0;
          const parser = new SseParser();
          const decoder = new TextDecoder();
          const reader = response.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done || subscriber.closed) {
              break;
            }
            for (const message of parser.push(decoder.decode(value, { stream: true }))) {
              subscriber.next(message);
            }
            lastEventId = parser.lastEventId;
            serverRetryMs = parser.retryMs ?? serverRetryMs;
          }
        }
      } catch {
        // Rede caiu ou a requisição foi abortada: a reconexão (ou o fim) decide abaixo.
      }
      if (!controller.signal.aborted) {
        reconnect(retryAfterMs);
      }
    };

    void connect();

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  });
}

/** Lê o `data:` das mensagens de um evento como JSON. */
export function sseJson<T>(message: SseMessage): T {
  return JSON.parse(message.data) as T;
}
