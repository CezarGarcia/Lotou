import { Directive, ElementRef, inject } from '@angular/core';
import { NgControl } from '@angular/forms';
import { cpfDigits, formatCpf } from './cpf';

/** Posição logo depois do n-ésimo dígito do texto formatado. */
export function caretAfterDigits(formatted: string, digits: number): number {
  if (digits === 0) {
    return 0;
  }
  let seen = 0;
  for (let i = 0; i < formatted.length; i++) {
    if (/\d/.test(formatted[i]) && ++seen === digits) {
      return i + 1;
    }
  }
  return formatted.length;
}

/**
 * Máscara de CPF (`000.000.000-00`) enquanto o comprador digita. Mantém o cursor
 * no lugar, mesmo editando no meio, e abre o teclado numérico no celular.
 */
@Directive({
  selector: 'input[appCpfMask]',
  host: {
    inputmode: 'numeric',
    autocomplete: 'off',
    maxlength: '14',
    '(input)': 'format()',
  },
})
export class CpfMask {
  private readonly element = inject<ElementRef<HTMLInputElement>>(ElementRef);
  private readonly ngControl = inject(NgControl, { self: true, optional: true });

  protected format(): void {
    const input = this.element.nativeElement;
    const caret = input.selectionStart ?? input.value.length;
    const digitsBeforeCaret = cpfDigits(input.value.slice(0, caret)).length;
    const formatted = formatCpf(input.value);
    if (formatted === input.value) {
      return;
    }
    input.value = formatted;
    this.ngControl?.control?.setValue(formatted);
    const position = caretAfterDigits(formatted, digitsBeforeCaret);
    input.setSelectionRange(position, position);
  }
}
