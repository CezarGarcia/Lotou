import { SeatMapState } from './seat-map.state';

/** Fileira A com 4 cadeiras, B com 6 e C com 2. */
function map() {
  const state = new SeatMapState([
    { label: 'A', seatCount: 4 },
    { label: 'B', seatCount: 6 },
    { label: 'C', seatCount: 2 },
  ]);
  const labels = state.rows.flatMap((row) => row.seats.map((seat) => seat.label));
  state.applySnapshot(labels.map((label) => ({ label, available: label !== 'B-3' })));
  return state;
}

describe('SeatMapState', () => {
  it('monta as fileiras na ordem do mapa, com as cadeiras de 1 a N', () => {
    const state = new SeatMapState([
      { label: 'A', seatCount: 2 },
      { label: 'B', seatCount: 4 },
    ]);
    expect(state.rows.map((row) => row.seats.map((seat) => seat.label))).toEqual([
      ['A-1', 'A-2'],
      ['B-1', 'B-2', 'B-3', 'B-4'],
    ]);
    expect(state.columns).toBe(4);
    // A fileira curta fica centralizada.
    expect(state.seat('A-1')!.column).toBe(1);
    expect(state.seat('B-1')!.column).toBe(0);
  });

  it('não deixa escolher antes da foto do setor chegar', () => {
    const state = new SeatMapState([{ label: 'A', seatCount: 2 }]);
    expect(state.loaded()).toBe(false);
    expect(state.seat('A-1')!.available()).toBeNull();
    expect(state.toggle('A-1')).toBe('unavailable');
  });

  it('escolhe e devolve cadeiras livres e recusa as ocupadas', () => {
    const state = map();
    expect(state.toggle('A-1')).toBe('selected');
    expect(state.isSelected('A-1')).toBe(true);
    expect(state.toggle('B-3')).toBe('unavailable');
    expect(state.toggle('A-1')).toBe('deselected');
    expect(state.count()).toBe(0);
    expect(state.toggle('Z-9')).toBe('unknown');
  });

  it('limita a 4 cadeiras e devolve a seleção na ordem do mapa', () => {
    const state = map();
    for (const label of ['C-1', 'A-2', 'B-6', 'A-1']) {
      expect(state.toggle(label)).toBe('selected');
    }
    expect(state.full()).toBe(true);
    expect(state.toggle('B-1')).toBe('limit');
    expect(state.selected()).toEqual(['A-1', 'A-2', 'B-6', 'C-1']);

    // Devolver uma abre espaço para outra.
    state.toggle('B-6');
    expect(state.toggle('B-1')).toBe('selected');
  });

  it('aplica as mudanças ao vivo só nas cadeiras citadas', () => {
    const state = map();
    const untouched = state.seat('A-4')!.available;
    expect(state.applyChange({ sectorId: 's', seats: ['A-1', 'A-2'], available: false })).toEqual(
      [],
    );
    expect(state.seat('A-1')!.available()).toBe(false);
    expect(untouched()).toBe(true);

    state.applyChange({ sectorId: 's', seats: ['B-3'], available: true });
    expect(state.toggle('B-3')).toBe('selected');
  });

  it('tira da seleção a cadeira que outra pessoa pegou e avisa quais foram', () => {
    const state = map();
    state.toggle('A-1');
    state.toggle('A-2');
    expect(state.applyChange({ sectorId: 's', seats: ['A-2', 'A-3'], available: false })).toEqual([
      'A-2',
    ]);
    expect(state.selected()).toEqual(['A-1']);
  });

  it('confere a seleção de novo quando chega uma foto nova (reconexão)', () => {
    const state = map();
    state.toggle('B-1');
    state.toggle('B-2');
    const lost = state.applySnapshot([
      { label: 'B-1', available: true },
      { label: 'B-2', available: false },
    ]);
    expect(lost).toEqual(['B-2']);
    expect(state.selected()).toEqual(['B-1']);
  });

  it('marca como ocupadas as cadeiras que a API recusou', () => {
    const state = map();
    state.toggle('A-3');
    expect(state.markUnavailable(['A-3'])).toEqual(['A-3']);
    expect(state.toggle('A-3')).toBe('unavailable');
  });

  it('navega pelo teclado pela fileira e entre fileiras, pela posição no desenho', () => {
    const state = map();
    expect(state.neighbor('A-1', 'left')).toBeUndefined();
    expect(state.neighbor('A-1', 'right')).toBe('A-2');
    expect(state.neighbor('B-2', 'end')).toBe('B-6');
    expect(state.neighbor('B-5', 'home')).toBe('B-1');
    // A-1 fica sobre B-2 (A tem 4 cadeiras centradas sobre as 6 de B).
    expect(state.neighbor('A-1', 'down')).toBe('B-2');
    expect(state.neighbor('B-6', 'up')).toBe('A-4');
    // C tem 2 cadeiras, centradas sob B-3 e B-4.
    expect(state.neighbor('B-1', 'down')).toBe('C-1');
    expect(state.neighbor('C-2', 'down')).toBeUndefined();
    expect(state.neighbor('A-2', 'up')).toBeUndefined();
  });
});
