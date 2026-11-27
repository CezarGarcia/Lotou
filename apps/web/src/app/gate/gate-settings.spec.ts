import { TestBed } from '@angular/core/testing';
import { GateSettings, normalizeGate, parseSectorList } from './gate-settings';

describe('GateSettings', () => {
  beforeEach(() => localStorage.clear());

  it('gera o id do aparelho uma vez e guarda', () => {
    const id = TestBed.inject(GateSettings).deviceId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(TestBed.inject(GateSettings).deviceId()).toBe(id);
    TestBed.resetTestingModule();
    expect(TestBed.inject(GateSettings).deviceId()).toBe(id);
  });

  it('guarda os setores do portão por show', () => {
    TestBed.inject(GateSettings).setSectors('s1', ['a', 'b']);
    TestBed.resetTestingModule();
    const settings = TestBed.inject(GateSettings);
    expect(settings.sectorsFor('s1')).toEqual(['a', 'b']);
    // Em outro show, o portão atende todos.
    expect(settings.sectorsFor('s2')).toEqual([]);
  });

  it('ignora o que não é uma escolha de setores', () => {
    localStorage.setItem('lotou.portaria.setores', '{quebrado');
    expect(TestBed.inject(GateSettings).sectorsFor('s1')).toEqual([]);
  });
});

describe('textos da URL', () => {
  it('lê a lista de setores do parâmetro', () => {
    expect(parseSectorList(' a, b,,a ')).toEqual(['a', 'b']);
    expect(parseSectorList('')).toEqual([]);
    expect(parseSectorList(undefined)).toEqual([]);
  });

  it('normaliza o portão', () => {
    expect(normalizeGate('  portão   b ')).toBe('portão b');
  });
});
