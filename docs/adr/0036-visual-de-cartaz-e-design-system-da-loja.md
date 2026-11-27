# 0036. Visual de cartaz de show, com o Angular Material restilizado e dois temas

- **Status:** aceita
- **Data:** 2026-11-27

## Contexto

Até a fase 7, a loja usava o tema padrão do Angular Material (roxo, Inter, cartões brancos) e uma capa gerada com as iniciais do artista. Tudo funcionava, mas a interface parecia um painel administrativo: nada nela lembrava um show. A fase 8 revisa o visual do sistema inteiro antes do vídeo de apresentação.

Três públicos usam o Lotou em situações diferentes: o comprador, no celular e muitas vezes à noite, com pressa e com medo de perder o ingresso; o produtor, no computador, lendo números por horas; e a equipe da portaria, de pé, com o celular numa mão e a fila andando. As referências pesquisadas (DICE, Resident Advisor, os cartazes de lambe-lambe das capitais brasileiras) tratam o show como um cartaz, com tipografia grande e cores chapadas, e não como um item de catálogo.

Os shows do seed são fictícios e não têm foto. Qualquer visual que dependa de imagem fica vazio.

## Decisão

- **O show é um cartaz de lambe-lambe.** Cada show vira um cartaz em duas cores (fundo e tinta), escolhidas pelo nome do artista entre seis pares que passam no contraste AA para texto grande, com a retícula de impressão por cima (um `radial-gradient` em CSS) e um carimbo inclinado com a data no fuso do show (`app-cartaz` e `app-date-stamp`, em `shared/ui`). O mesmo artista tem sempre a mesma cor, na vitrine, na página do show, no ingresso e no painel. O cartaz é decorativo (`aria-hidden`); o nome e a data aparecem também em texto.
- **Tipografia:** Big Shoulders Display (títulos altos e estreitos, em caixa alta, como letra de cartaz), Inter no texto e DM Mono nas etiquetas (data, local, estado, rótulos de métrica). As três são servidas pelo próprio site com o Fontsource, sem chamada ao Google Fonts: menos uma conexão antes do primeiro texto e nenhum dado do comprador indo para terceiros.
- **Dois temas, escolhidos pela área da rota.** Noite (fundo `#121015`) na loja e na portaria: é a hora em que o comprador e a portaria usam o sistema, e o escuro faz as cores dos cartazes saltarem. Dia (fundo `#F3F1F6`, cartões brancos) no painel do produtor, que é trabalho de escritório. O cabeçalho é escuro nos dois. O tema é uma classe no `<html>` (`tema-noite` ou `tema-dia`, posta pelo serviço `AppArea`), para que diálogos e menus do Material, que abrem fora da árvore do componente, sigam o tema da tela.
- **Uma cor de ação.** O amarelo `#FFD23F`, com texto preto, é a ação principal em todas as telas (comprar, pagar, entrar). Verde, amarelo e vermelho ficam reservados para estado (liberado, atenção, recusado), o que importa na portaria, onde a cor é lida antes do texto.
- **Angular Material continua, restilizado.** Os componentes dele resolvem acessibilidade e comportamento (diálogo com foco preso, campos com rótulo e erro, menus e abas com teclado). O visual vem dos tokens do Lotou (`--lt-*`, em `styles.scss`), e cada tema redefine as variáveis `--mat-sys-*` a partir deles; os ajustes de forma (botões em pílula, campos com cantos de 14 px, diálogos com 24 px) usam os mixins `*-overrides` do Material, sem CSS que dependa da estrutura interna dos componentes.
- **Ícones Lucide com o `@ng-icons`**, no lugar da fonte Material Symbols: traço fino que combina com a tipografia, cada tela registra só os ícones que usa (entram no pacote dela, sem baixar uma fonte inteira de ícones), e o pacote é compatível com o Angular 22.
- **Movimento curto e opcional.** Transição entre telas com a View Transitions API do navegador (`withViewTransitions` do roteador), cartazes que se inclinam no hover e a linha que varre o leitor da portaria. Tudo é desligado com `prefers-reduced-motion`.
- **Celular primeiro na loja e na portaria.** Na loja, o celular ganha uma barra de abas (início, buscar e ingressos) nas telas de navegação; nas de compra, ela dá lugar à barra de pagamento. O leitor da portaria abre em modo foco, sem cabeçalho nem rodapé, com o resultado da leitura ocupando a tela inteira.

## Alternativas consideradas

- **Trocar o Angular Material por uma biblioteca com visual pronto (PrimeNG, Spartan, Tailwind com componentes).** Daria outro visual genérico, não o do Lotou, e trocaria componentes testados e acessíveis por uma reescrita de todas as telas. O problema era o tema, não os componentes.
- **Fotos de banco de imagem nos shows.** Fotos genéricas de palco deixam todos os shows parecidos e dependem de arquivos externos; o cartaz tipográfico identifica o show pelo nome, que é o que o comprador procura.
- **Um tema só, escuro em tudo.** O painel é lido por horas, com tabelas e números; o tema claro cansa menos nesse uso e separa visualmente o trabalho do produtor da vitrine.
- **`lucide-angular`.** É a biblioteca oficial do Lucide, mas ainda não declara compatibilidade com o Angular 22.

## Consequências

- O visual inteiro sai de um arquivo de tokens: mudar a cor de ação ou o fundo é mudar uma variável.
- Os cartazes não precisam de imagem nem de upload, e o seed continua sem arquivos; quando o produtor puder enviar a arte do show, ela entra no lugar do cartaz gerado.
- Há três famílias de fonte para baixar. Cada uma vem dividida por alfabeto (`unicode-range`), então o navegador baixa só o latim, e com `font-display: swap` o texto aparece antes da fonte.
- Os testes ponta a ponta continuam escritos por papel e texto (botão "Pagar", diálogo "Cancelar pedido"), não por classe CSS, então sobreviveram à troca do visual com poucas mudanças.
