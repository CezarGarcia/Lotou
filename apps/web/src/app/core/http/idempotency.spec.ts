import { AttemptKey, uuidv7 } from './idempotency';

describe('uuidv7', () => {
  it('gera um UUID versão 7 com o instante nos primeiros 48 bits', () => {
    const now = Date.UTC(2027, 0, 1, 12, 0, 0);
    const id = uuidv7(now);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(parseInt(id.replace(/-/g, '').slice(0, 12), 16)).toBe(now);
  });

  it('ordena pelo instante e não se repete', () => {
    const older = uuidv7(1_000);
    const newer = uuidv7(2_000);
    expect(older < newer).toBe(true);
    expect(uuidv7()).not.toBe(uuidv7());
  });
});

describe('AttemptKey', () => {
  it('repete a chave enquanto o pedido é o mesmo', () => {
    const attempt = new AttemptKey();
    const key = attempt.for({ sectorId: 's1', quantity: 2 });
    expect(attempt.for({ sectorId: 's1', quantity: 2 })).toBe(key);
  });

  it('troca a chave quando o pedido muda ou a tentativa é encerrada', () => {
    const attempt = new AttemptKey();
    const first = attempt.for({ quantity: 2 });
    const second = attempt.for({ quantity: 3 });
    expect(second).not.toBe(first);

    attempt.reset();
    expect(attempt.for({ quantity: 3 })).not.toBe(second);
  });
});
