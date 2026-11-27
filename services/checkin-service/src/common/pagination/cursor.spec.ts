import { newId } from '../ids.js';
import { cursorSchema, encodeCursor, toPage } from './cursor.js';

describe('cursor', () => {
  it('decodifica o que codificou', () => {
    const position = { sortValue: Date.UTC(2027, 0, 15), id: newId() };
    expect(cursorSchema.parse(encodeCursor(position))).toEqual(position);
  });

  it('recusa cursor que não é base64url de [número, uuid]', () => {
    const encode = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString('base64url');

    expect(cursorSchema.safeParse('%%%').success).toBe(false);
    expect(cursorSchema.safeParse(encode('texto')).success).toBe(false);
    expect(cursorSchema.safeParse(encode([1, 'não-é-uuid'])).success).toBe(
      false,
    );
    // Um objeto no lugar do número não pode chegar à consulta.
    expect(cursorSchema.safeParse(encode([{ $gt: 0 }, newId()])).success).toBe(
      false,
    );
  });
});

describe('toPage', () => {
  const items = [1, 2, 3].map((n) => ({ id: newId(), n }));
  const position = (item: { id: string; n: number }) => ({
    sortValue: item.n,
    id: item.id,
  });

  it('devolve nextCursor quando veio um item além do limite', () => {
    const page = toPage(items, 2, position, (item) => item.n);
    expect(page.items).toEqual([1, 2]);
    expect(cursorSchema.parse(page.nextCursor)).toEqual(position(items[1]));
  });

  it('devolve nextCursor nulo na última página', () => {
    expect(toPage(items, 3, position, (item) => item.n)).toEqual({
      items: [1, 2, 3],
      nextCursor: null,
    });
  });
});
