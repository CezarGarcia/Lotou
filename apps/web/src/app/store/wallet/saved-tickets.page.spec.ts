import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';
import { NetworkStatus } from '../../core/ui/network-status';
import { SavedTicketsPage } from './saved-tickets.page';
import { TicketWallet } from './ticket-wallet';
import { inDays, testOrder, testShow, testTicket } from './wallet.testing';

describe('SavedTicketsPage', () => {
  const online = signal(false);

  function render() {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: AuthService, useValue: { userId: () => '' } },
        { provide: NetworkStatus, useValue: { online } },
      ],
    });
    return TestBed;
  }

  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('sem internet e sem login, mostra os ingressos salvos com o QR de cada um', async () => {
    online.set(false);
    render();
    TestBed.inject(TicketWallet).remember(
      'comprador-1',
      testOrder('o1', 's1', [testTicket('t1'), testTicket('t2', 'USED')]),
      testShow('s1', inDays(3), 'Nação Coral'),
    );
    const fixture = TestBed.createComponent(SavedTicketsPage);
    fixture.detectChanges();
    await fixture.whenStable();
    const page: HTMLElement = fixture.nativeElement;

    expect(page.querySelector('[role=status]')?.textContent).toContain('Sem internet');
    expect(page.querySelector('h2')?.textContent).toContain('Nação Coral');
    // Só o ingresso válido aparece: o usado não entra de novo.
    expect(page.querySelectorAll('app-ticket-stub').length).toBe(1);
  });

  it('sem nada salvo, explica como os ingressos chegam aqui', () => {
    online.set(true);
    render();
    const fixture = TestBed.createComponent(SavedTicketsPage);
    fixture.detectChanges();
    const page: HTMLElement = fixture.nativeElement;
    expect(page.textContent).toContain('Nenhum ingresso salvo aqui');
    expect(page.querySelector('a[href="/meus-ingressos"]')).not.toBeNull();
  });
});
