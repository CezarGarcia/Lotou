import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { CancelShowDialog, matchesShowName } from './cancel-show.dialog';
import { ShowShellPage } from './show-shell.page';

const SHOW = {
  id: 's1',
  title: 'Turnê Mar Aberto',
  artist: 'Banda do Mar',
  status: 'ON_SALE',
  startsAt: '2031-01-01T01:00:00.000Z',
  venue: { id: 'v1', name: 'Arena', city: 'Recife', state: 'PE', timezone: 'America/Recife' },
  sectors: [],
};

const plain = (text: string) => text.replace(/ /g, ' ').replace(/\s+/g, ' ');

describe('matchesShowName', () => {
  it('confere o nome sem ligar para maiúsculas e espaços', () => {
    expect(matchesShowName('turnê mar aberto', 'Turnê Mar Aberto')).toBe(true);
    expect(matchesShowName('  Turnê   Mar Aberto ', 'Turnê Mar Aberto')).toBe(true);
  });

  it('exige o nome inteiro, com acento', () => {
    expect(matchesShowName('Turnê Mar', 'Turnê Mar Aberto')).toBe(false);
    expect(matchesShowName('Turne Mar Aberto', 'Turnê Mar Aberto')).toBe(false);
    expect(matchesShowName('', '')).toBe(false);
  });
});

describe('ShowShellPage', () => {
  let fixture: ComponentFixture<ShowShellPage>;
  let http: HttpTestingController;
  let dialogAnswer: boolean | undefined;
  let opened: unknown[];
  let snack: ReturnType<typeof vi.fn>;

  const element = () => fixture.nativeElement as HTMLElement;
  const text = () => plain(element().textContent!);

  async function settle() {
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }
    fixture.detectChanges();
  }

  async function render(show: object = SHOW) {
    opened = [];
    snack = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: MatSnackBar, useValue: { open: snack } },
        {
          provide: MatDialog,
          useValue: {
            open: (component: unknown, config: unknown) => {
              opened.push([component, config]);
              return { afterClosed: () => of(dialogAnswer) };
            },
          },
        },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(ShowShellPage);
    fixture.componentRef.setInput('id', 's1');
    fixture.detectChanges();
    await settle();
    http.expectOne('/api/v1/shows/s1').flush(show);
    await settle();
  }

  const cancelButton = () =>
    [...element().querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent!.includes('Cancelar show'),
    );

  it('mostra o show e as abas Ao vivo, Financeiro e Cupons', async () => {
    await render();
    expect(text()).toContain('Banda do Mar');
    expect(text()).toContain('Turnê Mar Aberto · 31/12/2030 às 22:00');
    const tabs = [...element().querySelectorAll('nav a')].map((a) => [
      plain(a.textContent!).trim(),
      a.getAttribute('href'),
    ]);
    expect(tabs).toEqual([
      ['Ao vivo', '/'],
      ['Financeiro', '/financeiro'],
      ['Cupons', '/cupons'],
    ]);
  });

  it('só cancela depois da confirmação forte, e explica o reembolso', async () => {
    await render();
    dialogAnswer = false;
    cancelButton()!.click();
    expect(opened[0]).toEqual([
      CancelShowDialog,
      expect.objectContaining({ data: { title: 'Turnê Mar Aberto', artist: 'Banda do Mar' } }),
    ]);
    http.expectNone('/api/v1/shows/s1/cancel');

    dialogAnswer = true;
    cancelButton()!.click();
    http.expectOne('/api/v1/shows/s1/cancel').flush(null, { status: 200, statusText: 'OK' });
    expect(snack).toHaveBeenCalledWith(
      'Show cancelado. Os reembolsos dos pedidos confirmados já começaram.',
      'OK',
      { duration: 8_000 },
    );
    // Relê o show, que agora está cancelado.
    await settle();
    http.expectOne('/api/v1/shows/s1').flush({ ...SHOW, status: 'CANCELLED' });
    await settle();
    expect(cancelButton()).toBeUndefined();
    expect(text()).toContain('Show cancelado. Os pedidos confirmados são reembolsados');
  });

  it.each(['DRAFT', 'SALES_CLOSED', 'FINISHED', 'CANCELLED'])(
    'não oferece cancelar um show %s',
    async (status) => {
      await render({ ...SHOW, status });
      expect(cancelButton()).toBeUndefined();
    },
  );

  it('explica quando o servidor recusa o cancelamento', async () => {
    await render();
    dialogAnswer = true;
    cancelButton()!.click();
    http
      .expectOne('/api/v1/shows/s1/cancel')
      .flush({ title: 'Conflito', status: 409 }, { status: 409, statusText: 'Conflict' });
    expect(snack.mock.calls[0][0]).toContain('não pode mais ser cancelado');
    await settle();
    http.expectOne('/api/v1/shows/s1').flush(SHOW);
  });
});

describe('CancelShowDialog', () => {
  it('só libera o botão com o nome do show digitado', async () => {
    const close = vi.fn();
    const { MAT_DIALOG_DATA, MatDialogRef } = await import('@angular/material/dialog');
    TestBed.configureTestingModule({
      providers: [
        { provide: MAT_DIALOG_DATA, useValue: { title: 'Turnê Mar Aberto', artist: 'Banda' } },
        { provide: MatDialogRef, useValue: { close } },
      ],
    });
    const fixture = TestBed.createComponent(CancelShowDialog);
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    expect(plain(element.textContent!)).toContain('Todo pedido confirmado é reembolsado');
    const confirm = [...element.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent!.includes('Cancelar show e reembolsar'),
    )!;
    expect(confirm.disabled).toBe(true);

    const input = element.querySelector<HTMLInputElement>('input')!;
    input.value = 'Turnê Mar';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(confirm.disabled).toBe(true);

    input.value = 'turnê mar aberto';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(confirm.disabled).toBe(false);
    confirm.click();
    expect(close).toHaveBeenCalledWith(true);
  });
});
