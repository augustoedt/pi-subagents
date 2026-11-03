# Estado do projeto

Atualizado em 2026-11-03. Checkpoint autoritativo deste fork.

## Onde estamos

- Branch `feat/better-subagent`, derivada de `feat/show-subagent-edits` em
  `7d0f576`. Primeiro recorte commitado em `0874e63`, sem push.
- Recorte 2 (`write_scope`) implementado, validado e commitado nesta entrega
  por autorização do usuário, **sem push**. `main` permanece em `69d7ea6`, reservada para atualizações do upstream.
- Pi carrega `/Users/augusto/Projects/Agents/pi-subagents`. Usuário confirmou
  nova recarga; `write_scope` conferido nos três tools e smoke com worker real
  aprovado. Editar/trocar branch muda a fonte da próxima recarga.
- Nenhuma alteração do Pi core, instalação de dependências ou publicação
  neste recorte. Configuração global preservada.

## Implementado

- Contrato anterior: `context_files`, `acceptance`, `constraints`, preflight
  e `Delivery v1`; declaração, processo e evidência separados. Aceite sempre
  `not_verified`, inclusive com exit zero ou YES do judge.
- `write_scope` em `subagent`, por passo de `pipeline` e no `loop`/judge:
  caminhos canônicos de arquivos ou diretórios existentes; vazio nega escrita.
  Omitido preserva o perfil; `null` é rejeitado antes da coerção do runtime.
- `scoped_edit`/`scoped_write` substituem somente capacidades já declaradas.
  Modo restrito remove shell/código, ferramentas arbitrárias/rede/MCP e
  subdelegação. Builds/testes ficam no coordenador, com aviso no relatório.
- Guardas contra escapes, links pendentes, hardlinks, arquivos especiais e
  `.git`; extensão ausente/inválida não restaura mutadores originais.
  Retry mantém escopo; herança não amplia; envExtra não injeta política.
- Eventos protegidos entram em evidências/diffs/`/se`, sem inventar diffs para
  `write`. Raízes são caminhos canônicos, não identidades/inodes ou locks.

## Evidência

- `npm test`: **459 testes em 28 arquivos aprovados**, baseline do recorte 424.
- `git diff --check` aprovado. Testes de orquestração simulam subprocessos;
  testes de operações usam filesystem/implementações reais em fixtures.
- `scripts/smoke-write-scope.mjs`, com SDK da instalação real do Pi: quatro
  cenários aprovados (válido, ausente, inválido, vazio), **61 probes** via
  `ctx.executeTool`, incluindo tentativas de chamar mutadores originais/custom/MCP.
  Loader principal/report também aprovado. Turnos sintéticos; zero chamadas LLM.
- Smoke inicial precisou corrigir a fixture para registrar turno sintético
  no SessionManager; sucesso final não depende do erro genérico de falta de turno.
- Análise adicional somente leitura levantou pinagem por inode; mantido o
  contrato por pathname, com teste explícito: recriar no mesmo caminho não
  amplia escopo; symlink para outro caminho continua bloqueado.
- Após recarga, worker real com escopo em diretório temporário: edit/create
  permitidos, duas tentativas externas rejeitadas segundo o relatório do filho.
  Coordenador conferiu bytes exatos dos três arquivos, sentinela intacta e
  inventário sem arquivos extras. Fixture removida após verificação.
- Resultado persistido conferido: duas escritas bem-sucedidas dentro do escopo,
  zero comandos, `safe_bash`/`subagent` desabilitados; um `scoped_edit` com diff
  salvo para `/se`, uma edição falha e nenhum diff de sucesso fora do escopo.
  `Delivery.observed.incomplete: true` é esperado: o coletor marca mutações
  falhas conservadoramente, inclusive os probes negativos. Aceite no relatório
  continua `not_verified`; conferência independente não altera esse contrato.
- Não verificados: UI interativa do explorer, smoke com modelo em pipeline/loop,
  outras plataformas e isolamento OS (não oferecido).

## Em andamento e próximo passo

1. Usuário pode abrir `/se` e selecionar o smoke recente para conferir a UI:
   resultado e diff `SMOKE_BEFORE` → `SMOKE_AFTER`. Dados persistidos já verificados;
   interação visual ainda pendente, mesmo com a fixture temporária removida.
2. Publicação/push somente mediante nova autorização; commit do recorte 2
   autorizado e incluído nesta entrega. Nenhum outro recorte aprovado para
   implementação; planos concluídos foram arquivados.
3. Planejar coordenação de recursos separadamente, sem iniciar implementação
   ou ampliar permissões por consequência deste smoke.

## Armadilhas conhecidas

- `researcher` exige `web_search` não mapeado; preflight normal bloqueia.
  Não instalar extensões nem retirar ferramentas do perfil por consequência.
  No modo restrito, ferramentas de rede são removidas explicitamente.
- Proteção no limite das ferramentas, não sandbox OS/confinamento de leitura.
  Código confiável de extensões/guardas, processos externos e TOCTOU entre
  processos não ficam isolados. Não usar escopo como permissão para alterar
  runtime confiável e esperar autoproteção; alterações nele exigem validação
  pelo coordenador antes de nova execução/recarga.
- Diretórios de escopo devem existir antes de iniciar o pipeline. Cwd,
  contexto e constraints não concedem nem ampliam permissão de escrita.
- Backups/rollback: referência antiga fixada em `7d0f576`; backup privado
  `~/.pi/agent/backups/settings-before-better-subagent-20261103T220625Z.json`.
  Reverter somente a entrada do pacote, nunca sobrescrever settings posteriores.
- Coordenação/locks, continuidade de sessões e evolução do explorer são recortes
  separados. Alertas de background pertencem a outra extensão.

## Referências

[Contrato público](../../README.md#controlled-write-scope) ·
[Recorte 2 concluído](../archive/write-scope.md) ·
[Recorte 1](../archive/better-subagent.md) ·
[Validar, ativar e reverter](../runbooks/desenvolvimento-local.md) ·
[Índice](../README.md).
