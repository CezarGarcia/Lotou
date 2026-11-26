import { FormControl } from '@angular/forms';
import { caretAfterDigits } from './cpf-mask';
import { cpfValidator, formatCpf, isValidCpf } from './cpf';

describe('isValidCpf', () => {
  it('aceita CPFs com os dígitos verificadores certos, com ou sem máscara', () => {
    expect(isValidCpf('529.982.247-25')).toBe(true);
    expect(isValidCpf('52998224725')).toBe(true);
    expect(isValidCpf('111.444.777-35')).toBe(true);
    // Resto 10 vira 0: no primeiro dígito verificador e no segundo.
    expect(isValidCpf('123.456.789-09')).toBe(true);
    expect(isValidCpf('987.654.321-00')).toBe(true);
  });

  it('recusa dígito verificador errado, tamanho errado e sequências repetidas', () => {
    expect(isValidCpf('529.982.247-24')).toBe(false);
    expect(isValidCpf('529.982.247-15')).toBe(false);
    expect(isValidCpf('5299822472')).toBe(false);
    expect(isValidCpf('529982247250')).toBe(false);
    expect(isValidCpf('111.111.111-11')).toBe(false);
    expect(isValidCpf('000.000.000-00')).toBe(false);
    expect(isValidCpf('')).toBe(false);
  });
});

describe('formatCpf', () => {
  it('aplica a máscara aos poucos, conforme a digitação', () => {
    expect(formatCpf('')).toBe('');
    expect(formatCpf('529')).toBe('529');
    expect(formatCpf('5299')).toBe('529.9');
    expect(formatCpf('5299822')).toBe('529.982.2');
    expect(formatCpf('5299822472')).toBe('529.982.247-2');
    expect(formatCpf('52998224725')).toBe('529.982.247-25');
  });

  it('ignora o que não é dígito e corta no 11º', () => {
    expect(formatCpf('529.982.247-25999')).toBe('529.982.247-25');
    expect(formatCpf('abc 529 x')).toBe('529');
  });
});

describe('caretAfterDigits', () => {
  it('põe o cursor logo depois do mesmo número de dígitos', () => {
    expect(caretAfterDigits('529.982.247-25', 0)).toBe(0);
    expect(caretAfterDigits('529.982.247-25', 3)).toBe(3);
    expect(caretAfterDigits('529.982.247-25', 4)).toBe(5);
    expect(caretAfterDigits('529.982.247-25', 11)).toBe(14);
  });
});

describe('cpfValidator', () => {
  const errors = (value: string) => cpfValidator(new FormControl(value));

  it('deixa o vazio para o required e separa incompleto de inválido', () => {
    expect(errors('')).toBeNull();
    expect(errors('529.982')).toEqual({ cpfIncomplete: true });
    expect(errors('529.982.247-24')).toEqual({ cpf: true });
    expect(errors('529.982.247-25')).toBeNull();
  });
});
