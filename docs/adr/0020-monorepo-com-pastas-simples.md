# 0020. Monorepo com pastas simples

- **Status:** aceita
- **Data:** 2026-11-26

## Contexto

O Lotou tem nove serviços em três linguagens (Java, Node e Python), um frontend Angular, contratos de eventos, infraestrutura, testes de carga e documentação. É preciso decidir como organizar isso em repositórios e com qual ferramenta de build.

As alternativas eram:

1. **Um repositório por serviço.** Isola bem, mas espalha um projeto de portfólio em dez lugares: quem avalia não vê o sistema inteiro, e uma mudança de contrato vira vários pull requests coordenados.
2. **Monorepo com Nx** (ou ferramenta parecida). Dá cache de build e grafo de dependências, mas o Nx nasceu no ecossistema JavaScript. Com Maven e Python no meio, ele vira uma camada a mais por cima das ferramentas nativas, sem relação com os objetivos do projeto.
3. **Monorepo com pastas simples**, cada serviço usando a ferramenta nativa da sua linguagem.

## Decisão

Um único repositório, com pastas simples:

- `apps/web` para o Angular e `services/<nome>` para cada serviço.
- Cada serviço é autocontido e usa a ferramenta nativa da linguagem: Maven nos serviços Java, npm nos serviços Node e no Angular, uv nos serviços Python. Entrar na pasta e rodar o build funciona sem nada da raiz.
- Na raiz ficam só o que é do conjunto: o `Makefile` (`up`, `down`, `test`, `seed`), o Docker Compose e o CI.
- O CI (GitHub Actions) usa filtros de caminho: cada serviço tem seu workflow, que só roda quando a pasta dele muda.
- Nenhum código é compartilhado entre serviços por import. O que eles compartilham são contratos: a API REST e os JSON Schemas de eventos em `contracts/`.

## Consequências

- Cada serviço fica como seria numa empresa com um repositório por time, e pode ser extraído do monorepo sem reescrever o build.
- Quem abre o repositório vê o sistema inteiro, e uma mudança que atravessa serviços cabe num commit só.
- Não há cache de build compartilhado nem grafo de dependências entre projetos. Os filtros de caminho do CI cobrem a parte que importa: não rodar tudo a cada push.
- Convenções comuns (formato de erro, envelope de eventos, log em JSON) são repetidas em cada linguagem em vez de virar biblioteca compartilhada. É uma duplicação aceita, porque uma biblioteca comum acoplaria as versões dos serviços.
- O `Makefile` precisa ser mantido à mão quando um serviço novo entra.
