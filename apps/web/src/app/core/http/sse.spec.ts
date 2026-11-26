import { Subscription } from 'rxjs';
import { SseError, SseMessage, SseParser, readSse } from './sse';

describe('SseParser', () => {
  it('entrega cada mensagem na linha em branco, com o nome do evento', () => {
    const parser = new SseParser();
    expect(
      parser.push('event: snapshot\ndata: {"a":1}\n\nevent: seats\ndata: {"b":2}\n\n'),
    ).toEqual([
      { event: 'snapshot', data: '{"a":1}' },
      { event: 'seats', data: '{"b":2}' },
    ]);
  });

  it('usa "message" quando o evento não tem nome e junta várias linhas de data', () => {
    const parser = new SseParser();
    expect(parser.push('data: primeira\ndata: segunda\n\n')).toEqual([
      { event: 'message', data: 'primeira\nsegunda' },
    ]);
  });

  it('remonta linhas partidas entre pedaços, inclusive um \\r\\n dividido', () => {
    const parser = new SseParser();
    expect(parser.push('event: sta')).toEqual([]);
    expect(parser.push('tus\r')).toEqual([]);
    expect(parser.push('\ndata: {"position":')).toEqual([]);
    expect(parser.push('3}\r\n\r\n')).toEqual([{ event: 'status', data: '{"position":3}' }]);
  });

  it('ignora comentários (heartbeats) e campos desconhecidos', () => {
    const parser = new SseParser();
    expect(parser.push(': ping\n\n:\nfoo: bar\ndata: x\n\n')).toEqual([
      { event: 'message', data: 'x' },
    ]);
  });

  it('não entrega mensagem sem data e descarta o evento pendente', () => {
    const parser = new SseParser();
    expect(parser.push('event: vazio\n\ndata: depois\n\n')).toEqual([
      { event: 'message', data: 'depois' },
    ]);
  });

  it('guarda o último id e o retry do servidor', () => {
    const parser = new SseParser();
    expect(parser.push('id: 41\nretry: 5000\ndata: a\n\ndata: b\n\n')).toEqual([
      { event: 'message', data: 'a', id: '41' },
      { event: 'message', data: 'b', id: '41' },
    ]);
    expect(parser.lastEventId).toBe('41');
    expect(parser.retryMs).toBe(5000);
    parser.push('retry: depressa\n\n');
    expect(parser.retryMs).toBe(5000);
  });

  it('aceita fim de linha só com \\r, valor sem espaço e BOM no início', () => {
    const parser = new SseParser();
    // O último \r espera o próximo pedaço: podia ser a metade de um \r\n.
    expect(parser.push('\uFEFFdata:sem-espaco\r\r')).toEqual([]);
    expect(parser.push('data:  dois espaços\n\n')).toEqual([
      { event: 'message', data: 'sem-espaco' },
      { event: 'message', data: ' dois espaços' },
    ]);
  });
});

/** Uma resposta de SSE que o teste controla pedaço a pedaço. */
function stream() {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) });
  return {
    response: new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }),
    send: (text: string) => controller.enqueue(encoder.encode(text)),
    end: () => controller.close(),
  };
}

/** Deixa as promises pendentes (fetch, leitura do corpo) andarem. */
const settle = async () => {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
};

describe('readSse', () => {
  let subscription: Subscription | undefined;

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    subscription?.unsubscribe();
    vi.useRealTimers();
  });

  it('emite as mensagens e manda os cabeçalhos de cada conexão', async () => {
    const server = stream();
    const fetchFn = vi.fn().mockResolvedValue(server.response);
    const received: SseMessage[] = [];

    subscription = readSse('/api/v1/queue/s1/events', {
      fetch: fetchFn,
      headers: () => ({ Authorization: 'Bearer abc' }),
    }).subscribe((message) => received.push(message));
    await settle();

    server.send('event: status\ndata: {"status":"QUEUED"}\n\n: heartbeat\n\n');
    await settle();

    expect(received).toEqual([{ event: 'status', data: '{"status":"QUEUED"}' }]);
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/queue/s1/events');
    expect(init.headers).toEqual({ Accept: 'text/event-stream', Authorization: 'Bearer abc' });
  });

  it('reconecta com espera crescente quando o fluxo cai, mandando o Last-Event-ID', async () => {
    const first = stream();
    const second = stream();
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(first.response)
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(second.response);
    let headerCalls = 0;

    subscription = readSse('/sse', {
      fetch: fetchFn,
      headers: () => ({ 'X-Call': String(++headerCalls) }),
      initialDelayMs: 1_000,
      random: () => 0.5,
    }).subscribe();
    await settle();
    first.send('id: 7\ndata: a\n\n');
    first.end();
    await settle();

    // Primeira reconexão depois de 1 s; ela falha, e a próxima espera 2 s.
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchFn).toHaveBeenCalledTimes(3);

    const init = fetchFn.mock.calls[2][1] as RequestInit;
    expect(init.headers).toMatchObject({ 'Last-Event-ID': '7', 'X-Call': '3' });
  });

  it('termina com SseError num 4xx, sem reconectar', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          type: 'urn:lotou:problem:forbidden',
          title: 'Proibido',
          status: 403,
          detail: 'Sem permissão.',
        }),
        { status: 403, headers: { 'Content-Type': 'application/problem+json' } },
      ),
    );
    let error: unknown;

    subscription = readSse('/sse', { fetch: fetchFn }).subscribe({ error: (e) => (error = e) });
    await settle();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(error).toBeInstanceOf(SseError);
    expect((error as SseError).apiError).toMatchObject({ status: 403, code: 'forbidden' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('respeita o Retry-After de um 503 antes de tentar de novo', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503, headers: { 'Retry-After': '5' } }))
      .mockResolvedValue(stream().response);

    subscription = readSse('/sse', { fetch: fetchFn, random: () => 0.5 }).subscribe();
    await settle();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('recusa uma resposta que não é text/event-stream', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        new Response('<html></html>', { status: 200, headers: { 'Content-Type': 'text/html' } }),
      );
    let error: unknown;
    subscription = readSse('/sse', { fetch: fetchFn }).subscribe({ error: (e) => (error = e) });
    await settle();
    expect(error).toBeInstanceOf(SseError);
  });

  it('aborta a requisição e não reconecta ao cancelar a inscrição', async () => {
    const server = stream();
    const fetchFn = vi.fn().mockResolvedValue(server.response);

    subscription = readSse('/sse', { fetch: fetchFn }).subscribe();
    await settle();
    const { signal } = fetchFn.mock.calls[0][1] as RequestInit;
    subscription.unsubscribe();

    expect(signal!.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
