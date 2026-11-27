import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { ShowDatePipe } from '../../core/format/show-date.pipe';
import { ServiceFeePayer } from '../data/sale.models';
import { Show } from '../data/show.models';

/** A API do show já diz quem paga a taxa; o modelo da loja ainda não tem o campo. */
type ShowWithFee = Show & { serviceFeePaidBy?: ServiceFeePayer };

/**
 * O local do show e as regras da compra: cancelamento, taxa de serviço e a
 * entrada com o QR. Os textos seguem as regras de `docs/projeto.md`.
 */
@Component({
  selector: 'app-show-rules',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ShowDatePipe],
  template: `
    @let s = show();
    @if (s.venue; as venue) {
      <section aria-labelledby="local">
        <h2 id="local" class="section-title">O local</h2>
        <div class="venue panel">
          <div class="stage" aria-hidden="true">
            <span></span>
            <span></span>
            <span></span>
          </div>
          <div class="text">
            <strong>{{ venue.name }}</strong>
            <span>{{ venue.city }}/{{ venue.state }}</span>
            <span class="muted small">
              @if (s.doorsOpenAt) {
                Portões às {{ s.doorsOpenAt | showDate: venue.timezone : 'time' }}, show às
                {{ s.startsAt | showDate: venue.timezone : 'time' }}.
              }
              Os horários são os de {{ venue.city }}.
              @if (sectorNames()) {
                Setores: {{ sectorNames() }}.
              }
            </span>
          </div>
        </div>
      </section>
    }

    <section class="rules" aria-labelledby="regras">
      <h2 id="regras" class="sr-only">Regras da compra</h2>
      <div>
        <h3>Cancelamento</h3>
        <p>
          Até 7 dias depois da compra, se faltarem mais de 48 h para o show. O reembolso é integral,
          com a taxa.
        </p>
      </div>
      <div>
        <h3>Taxa de serviço</h3>
        <p>{{ feeText() }}</p>
      </div>
      <div>
        <h3>Na entrada</h3>
        <p>
          Mostre o QR do ingresso na tela do celular ou impresso. Ele é assinado, e cada ingresso
          libera uma entrada só.
        </p>
      </div>
    </section>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: 48px;
    }
    section {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .venue {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 24px;
      padding: 22px;
      border-radius: 18px;
    }
    .stage {
      display: flex;
      flex: 0 0 200px;
      flex-direction: column;
      align-items: center;
      justify-content: flex-end;
      gap: 8px;
      height: 136px;
      padding: 14px;
      border-radius: 12px;
      background: var(--lt-raised);
    }
    .stage span {
      height: 16px;
      width: 70%;
      border-radius: 4px;
      background: var(--lt-text);
      opacity: 0.85;
    }
    .stage span:nth-child(2) {
      height: 40px;
      width: 86%;
      border-radius: 30px 30px 8px 8px;
      background: var(--show-cor, var(--lt-cta));
      opacity: 0.8;
    }
    .stage span:nth-child(3) {
      height: 24px;
      width: 96%;
      border-radius: 30px 30px 8px 8px;
      background: var(--lt-cta);
      opacity: 0.75;
    }
    .text {
      display: flex;
      flex: 1 1 240px;
      flex-direction: column;
      gap: 4px;
      color: var(--lt-text-3);
    }
    .text strong {
      color: var(--lt-text);
      font-size: 1.25rem;
    }
    .small {
      font-size: 0.875rem;
    }
    .rules {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr));
      gap: 16px;
    }
    .rules div {
      padding-top: 12px;
      border-top: 3px solid var(--lt-cta);
    }
    h3 {
      margin: 0 0 4px;
      font-size: 1rem;
      font-weight: 700;
    }
    .rules p {
      margin: 0;
      color: var(--lt-muted);
      font-size: 0.9375rem;
    }
    @media (max-width: 479px) {
      .stage {
        flex-basis: 100%;
      }
    }
  `,
})
export class ShowRules {
  readonly show = input.required<Show>();

  protected readonly sectorNames = computed(() =>
    this.show()
      .sectors.map((sector) => sector.name)
      .join(', '),
  );

  protected readonly feeText = computed(() => {
    switch ((this.show() as ShowWithFee).serviceFeePaidBy) {
      case 'PRODUCER':
        return 'Neste show, a taxa de serviço é paga pelo produtor. Você paga só os ingressos.';
      case 'BUYER':
        return '10% por ingresso, mostrada no checkout antes de você pagar. Nada aparece depois.';
      default:
        return 'Quando cobrada, a taxa de 10% por ingresso aparece no checkout, antes de você pagar.';
    }
  });
}
