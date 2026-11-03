# Better subagent — primeiro recorte aprovado

## Objetivo e limites

Branch `feat/better-subagent`, derivada de `feat/show-subagent-edits` em
`7d0f576`. Preservar `main`, APIs antigas (`agent`, `task`, `cwd`), histórico
`/se` e a operação de pipeline/loop. Commit local autorizado após validação;
sem push ou merge.
Usar checkout local no Pi após validação, mantendo a referência anterior para
rollback. Não modificar o código do Pi nem outros projetos.

Entregas: contexto/aceite explícitos, relatório estruturado separando declaração
do agente de evidência observada, pré-requisitos verificados antes do spawn.
Sem sandbox, escopo de escrita imposto, locks compartilhados, retomada de
sessões ou correções da extensão de background neste recorte.

## Ledger

- [x] Conferir base limpa e criar branch.
- [x] Baseline de testes existentes: 360 aprovados.
- [x] Pré-requisitos: cwd, ferramentas/extensões necessárias e configuração.
- [x] Contexto opcional e critérios de aceite nos três orquestradores.
- [x] Relatório de entrega + evidências de ferramentas, sem inferir aprovação
  de testes a partir de texto/exit do processo do agente.
- [x] Final: 424 testes aprovados; integração com eventos/processos simulados
  e smoke real de carregamento da extensão, sem chamada de modelo paga.
- [x] Contrato, limites e rollback documentados; substituída somente a entrada
  do pacote em `~/.pi/agent/settings.json` pelo checkout local.
- [ ] Operador recarregar a sessão e confirmar funcionamento interativo.

Pré-requisito ausente encontrado no ambiente: `researcher` declara `web_search`
sem mapeamento disponível. Worker/scout/reviewer passaram no preflight real
cancelado antes do spawn. Nenhuma instalação ou alteração de perfil por consequência.

## Coordenação

Baseline e implementação de módulo isolado de pré-requisitos podem rodar em
paralelo. Workers tiveram propriedade exclusiva de módulos/testes de
pré-requisitos e contexto; sem executar comandos de validação ou alterar index.
Coordenador integrou schemas, contexto, relatórios, `index.ts`, testes reais de
orquestração com processo simulado, documentação e settings.
Testes finais dependem da integração; configuração do Pi depende dos gates.
Não recarregar o runtime em meio a ferramentas ativas. `/reload` ou nova sessão
será necessário para esta sessão passar a usar a versão local.

## Aceite

Chamadas antigas continuam válidas; campos novos são opcionais. Pipeline e
loop preservam relatórios por execução e contexto não vira autorização extra.
Falha de pré-requisito é explícita e não inicia o agente. Resultado ausente,
interrupção ou evidência truncada nunca são sucesso verificado. Metadados e
texto retornado são limitados e compatíveis com resultados históricos.

Referências: [checkpoint](../checkpoints/project-state.md), [índice](../README.md).
