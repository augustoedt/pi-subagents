# Estado do projeto

Atualizado em 2026-11-03. Checkpoint autoritativo deste fork.

## Onde estamos

- Branch `feat/better-subagent`. Recortes anteriores commitados em `0874e63`
  (contexto/evidência/preflight) e `5a33c4f` (escopo de escrita), sem push.
- Recortes **3 + 4 concluídos e commitados nesta entrega** por autorização do
  usuário, sem push. `main` permanece em `69d7ea6`, reservada para receber upstream.
- Pi carrega `/Users/augusto/Projects/Agents/pi-subagents`. Usuário confirmou
  recarga e teste funcional aprovado dos recortes 3 + 4; o launcher também foi
  exercitado isoladamente com worker real.
- Nenhuma instalação, alteração de settings/Pi core, publicação ou mudança em
  outros projetos. Checkout local continua sendo a fonte da próxima recarga.

## Implementado

Entrega concluída: [coordenação e continuidade](../archive/coordenacao-e-continuidade.md).

- `lib/resource-coordinator.ts`: admissão atômica de capacidade + reservas;
  sobreposição de write_scope e recursos nomeados serializa, trabalho independente
  inicia em paralelo, sem ultrapassar esperas anteriores conflitantes. Escritores
  sem escopo/custom tools desconhecidas usam reserva global conservadora.
- `resources` em subagent/pipeline/loop; limite de fila 64, timeout de fila 0 por
  padrão, configuráveis. Cancelamento na fila não faz spawn; reservas ativas
  permanecem até o filho encerrar. Metadados registram claims/motivo/tempo de espera.
- `lib/worker-sessions.ts` e `lib/continuity.ts`: criação/retomada opt-in somente
  em subagent. UUID pertence à sessão/instância; mesmo agente/perfil/modelo/thinking;
  cwd e escopo omitidos são herdados. Escopo só reduz permanentemente. Busy rejeita
  outro turno pendente/ativo. Pipeline/loop continuam efêmeros.
- Históricos privados temporários: diretórios 0700, JSONL precriado 0600 com header
  real do SDK; `--session` recebe caminho interno exato, `--model` fixa o modelo.
  Validar árvore/header/modelo antes de retomar; ausente/corrupto não cria sessão nova.
- Limites: 16 workers, 20 turnos, 16 MiB de transcript conferidos entre turnos
  (não quota de disco em execução). Sem truncamento/eviction silenciosa.
- Reload/troca/encerramento aborta a fila/filhos e descarta históricos próprios
  depois do término; crash pode deixar resíduos. Nenhuma retomada entre instâncias.
- Orquestrador não repete turnos persistentes automaticamente; isso não desativa
  retries internos de transporte do Pi/provedor. Evidência segue por turno,
  separando declaração/processo/aceite (`not_verified`), com referências anteriores.
- Integração em `index.ts`, schemas, config/preflight e Delivery. Novos testes
  unitários e integração exercitam o código real dos tools com spawn simulado.

## Evidência observada

- Final: **492 testes em 31 arquivos aprovados**, `npm test` (baseline 459/28).
  Cobertura nova: conflitos/independência/equidade, fila/abort/deadline/limites,
  retomada/posse/busy, narrowing, cwd herdado, modelo inesperado, cancelamento,
  invalidação e cleanup; pipeline e judge com recursos, sem continuidade implícita.
- Primeiras entregas de workers exigiram correções: canonicalização `/var` no
  macOS, limpeza com ancestral substituído por symlink, lifecycle e fixture de
  timeout com rejection não tratada. Gates finais acima substituem essas falhas.
- SDK instalado: `scripts/smoke-continuity.mjs` restaurou mesmo ID/transcript/contexto,
  honrou modelo/tools explícitos, redução permanente, modo 0600 e limpeza; sem LLM.
- `scripts/smoke-write-scope.mjs`: quatro cenários/61 probes aprovados; mutadores
  originais/custom/MCP indisponíveis mesmo com guardas ausentes/inválidos.
- Smoke **com worker real** via launcher novo isolado: task `bg_11hz_mw1bt0b1_1`,
  exit 0. Dois turnos, mesmo ID, nonce recuperado da conversa sem constar do segundo
  prompt e sem leitura de arquivos. Escopo `[]` herdado, zero escritas/comandos
  via ferramentas. Histórico administrativo é separado dessa contagem.
- `git diff --check` e links documentais conferidos. Typecheck separado não rodado:
  tsc não disponível; nenhuma dependência instalada. Usuário confirmou teste
  funcional após recarga; não houve inspeção visual independente de UI, testes
  em outras plataformas nem concorrência com modelos reais.
- Recorte 2 já teve smoke real e dados persistidos de `/se` conferidos. Validação
  visual independente é opcional/não bloqueante; usuário questionou a utilidade
  do explorer ao longo do tempo. Falhas esperadas de mutação podem marcar
  `Delivery.observed.incomplete: true` conservadoramente; não esconder esse sinal.

## Próximo passo

1. Nenhuma implementação pendente nos recortes 3 + 4. Publicação/push depende
   de nova autorização; main continua reservada ao upstream.
2. Reavaliar com o usuário a utilidade do recorte 5 (histórico/explorer) antes
   de elaborar novo plano. Não ampliar `/se` apenas por estar no roteiro anterior.
3. Typecheck separado, UI independente e outras plataformas continuam verificações
   não realizadas; não instalar ferramentas ou iniciar expansões por consequência.

## Armadilhas e limites

- Coordenação apenas entre filhos diretos desta extensão nesta instância. Não é
  lock OS, snapshot de leitura, coordenação de netos/outros Pi/editores/comandos.
- Write scope protege operações de ferramentas; não isola runtime confiável,
  processos externos ou TOCTOU. Não delegar alteração dos próprios guardas/runtime
  e presumir autoproteção. Diretórios de escopo devem existir antes do pipeline.
- Transcript contém contexto/código/saídas e é escrito pelo runtime fora de
  write_scope. Não compartilhar nem importar arquivos arbitrários. Resíduos de
  crash exigem identificação da execução encerrada; nunca apagar por glob global.
- `researcher` ainda exige web_search não mapeado: sem escopo, preflight bloqueia.
  Não instalar ou retirar ferramentas por consequência. Modo restrito remove rede.
- Backup de settings: `~/.pi/agent/backups/settings-before-better-subagent-20261103T220625Z.json`.
  Rollback substitui somente entrada do pacote por referência fixada `7d0f576`,
  depois recarrega; nunca sobrescrever configurações posteriores com backup inteiro.
- Alertas de background pertencem a outra extensão; este pacote não os modifica.

## Referências

[Recortes 3 + 4 concluídos](../archive/coordenacao-e-continuidade.md) ·
[Contrato público](../../README.md#resource-coordination-instance-local) ·
[Runbook de validação/ativação/rollback](../runbooks/desenvolvimento-local.md) ·
[Recorte 2](../archive/write-scope.md) · [Recorte 1](../archive/better-subagent.md) ·
[Índice](../README.md).
