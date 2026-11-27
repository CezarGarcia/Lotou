import { TestBed } from '@angular/core/testing';
import { create } from 'qrcode';
import { TicketQr, qrMatrix } from './ticket-qr';

const CODE = 'LOTOU1.0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b.dGVzdGUtYXNzaW5hdHVyYQ';

describe('qrMatrix', () => {
  it('desenha um quadrado por módulo escuro, com a zona de silêncio em volta', async () => {
    const { modules } = create(CODE, { errorCorrectionLevel: 'M' });
    const matrix = await qrMatrix(CODE);

    expect(matrix.size).toBe(modules.size + 4);
    const dark = Array.from(modules.data).filter(Boolean).length;
    expect(matrix.path.match(/M/g)).toHaveLength(dark);
    // O canto de cima à esquerda é sempre escuro (padrão de posição), deslocado pela zona.
    expect(matrix.path.startsWith('M2 2h1v1h-1z')).toBe(true);
  });
});

describe('TicketQr', () => {
  async function render(code: string | null | undefined) {
    const fixture = TestBed.createComponent(TicketQr);
    fixture.componentRef.setInput('code', code);
    fixture.componentRef.setInput('label', 'QR code do ingresso, Pista');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  it('desenha o QR do código do ingresso em SVG, com rótulo para leitores de tela', async () => {
    const element = await render(CODE);
    const svg = element.querySelector('svg')!;
    expect(svg).not.toBeNull();
    expect(svg.getAttribute('role')).toBe('img');
    expect(svg.getAttribute('aria-label')).toBe('QR code do ingresso, Pista');
    expect(svg.querySelector('path')!.getAttribute('d')).toMatch(/^M\d+ \d+h1v1h-1z/);
    // Preto no branco, mesmo no tema escuro.
    expect(svg.querySelector('rect')!.getAttribute('fill')).toBe('#fff');
  });

  it('ingresso antigo, sem código: QR indisponível', async () => {
    for (const code of [undefined, null, '']) {
      const element = await render(code);
      expect(element.querySelector('svg')).toBeNull();
      expect(element.textContent).toContain('QR indisponível');
    }
  });
});
