# Recortes 3 + 4 — coordenação de recursos e continuidade do worker

## Resumo

- Entrega **concluída**: implementação validada; usuário confirmou recarga,
  informou teste funcional aprovado e autorizou o commit dos recortes 3 + 4.
- Base: `feat/better-subagent`, `5a33c4f`; working tree limpa antes do planejamento.
- Entrega única com dois módulos desenvolvíveis em paralelo e integração comum.
- Implementado: coordenação na instância atual do Pi; workers retomáveis apenas
  durante a sessão/instância atual, sem recuperação entre processos/reinícios.
- Coordenação em subagent/pipeline/loop; retomada opt-in inicialmente em subagent.
- Commit local autorizado nesta entrega; push/publicação não autorizados.
- Preservados main, Pi core, settings e outros projetos. Não há próximo recorte
  aprovado; utilidade da evolução do explorer será reavaliada antes de planejá-la.

Detalhes da entrega aprovada e evidências abaixo.

## Evidência de exploração, não de implementação

Dois scouts executados em paralelo com `write_scope: []`: zero escritas/comandos
observados. Coordenador conferiu `index.ts` (lançamento e semáforo) e docs do Pi
instalado (`sessions.md`, opções de sessão em `cli.md`).

Hoje existe apenas semáforo por processo, sem reservas de recursos nem remoção
imediata de espera cancelada. Filhos usam `--no-session`; retry recria o processo.
O Pi suporta histórico em disco com `--session-dir` e `--session-id`/`--session`;
continuidade significa novo processo reutilizando histórico, **não processo vivo**.
`--session-id` pode criar sessão quando não encontra o ID: retomada precisa
validar existência antes, nunca anunciar retomada de histórico inexistente.

Os scouts também sugeriram persistência entre reinícios. Isso exige decisões
adicionais de retenção, posse e exclusão entre processos; não será introduzido
implicitamente sob uma trava somente em memória. Referências ao SDK são leitura,
não prova de funcionamento; smoke de retomada permanece um gate obrigatório.

## Recorte 3 — contrato implementado

- Substituir o semáforo por admissão única: capacidade e todas as reservas
  concedidas atomicamente; nenhum slot fica ocupado esperando outra reserva.
- Inferir reservas exclusivas de escrita de `write_scope` quando o perfil efetivo
  puder escrever: arquivo exato ou subárvore de diretório canônico. Sobreposição
  impede execução simultânea; caminhos independentes continuam paralelos.
- Adicionar `resources?: string[]` aos três orquestradores (por passo no pipeline,
  runner/judge no loop): nomes exclusivos, opacos, sem glob; até 20 nomes de
  128 caracteres. Duplicatas normalizadas; namespace interno não acessível.
  Recursos declarados não concedem ferramentas nem permissão de escrita.
- Escritores **sem escopo** (inclusive shell/custom tool desconhecida) recebem
  reserva global conservadora contra outros escritores. Isso reduz o paralelismo
  dessas chamadas, mas evita fingir que caminhos de shell foram inferidos.
- Perfis comprovadamente somente leitura podem executar juntos; leituras não
  ganham snapshot consistente automaticamente. Recursos explícitos podem proteger
  uma leitura coordenada. Não inferir arquivos lidos do texto da tarefa.
- Fila em ordem de chegada por conflito: tarefas independentes podem ultrapassar
  uma espera bloqueada, mas uma reserva posterior conflitante não ultrapassa a
  anterior. Não deixar a fila inteira parada por um recurso alheio ocupado.
- Cancelamento remove espera sem spawn; falha/timeout liberam reservas somente
  após o filho encerrar. Liberação idempotente em todos os caminhos, inclusive retry.
- Limite: 64 chamadas esperando; `queueTimeoutMs` configurável, default
  0 (sem deadline adicional, preservando compatibilidade). Timeout de execução
  continua separado; relatar estado de espera, motivo e duração.
- Pipeline libera ao concluir cada passo; loop libera entre runner/judge/iterações.
  Nenhuma reserva é mantida durante dependência de outro agente.

**Limite:** coordenação de chamadas irmãs desta extensão nesta instância. Não é
lock de filesystem, proteção de leitores externos nem coordenação de outros Pi,
netos, editor, git ou comandos manuais do coordenador. Não implementar takeover
por PID/heartbeat nem prometer recuperação de reservas entre processos.

## Recorte 4 — contrato implementado

API opt-in em `subagent`, preservando `agent`, `task`, `cwd`:

```json
{"agent":"worker","task":"Implementar a primeira parte","write_scope":[{"path":"src/feature","kind":"directory"}],"continuity":{"mode":"create"}}
```

A resposta informa `worker_session.id` opaco e número do turno. Para continuar:

```json
{"agent":"worker","task":"Corrigir o caso apontado","continuity":{"mode":"resume","worker_id":"<id retornado>"}}
```

- Sem `continuity`: execução efêmera atual, ainda com `--no-session`.
- Criação retomável exige `write_scope` explícito, inclusive `[]`. Nenhum worker
  retomável com shell/subdelegação neste recorte; mantém os guardas do recorte 2.
- IDs emitidos pelo coordenador e pertencentes à sessão/instância atual. Nunca
  aceitar caminhos arbitrários, IDs externos ou histórico de outra sessão.
- Mesmo agente/perfil, modelo concreto, thinking e cwd; mudança exige novo worker.
  Verificar modelo realmente usado pelo filho, não presumir que `--models` fixa
  uma sessão retomada. Falha de revalidação é erro antes do spawn.
- Omitir cwd/escopo na retomada herda os últimos valores. Escopo explícito só pode reduzir;
  redução é permanente para esse worker. Revalidar caminhos e ferramentas sempre.
- Uma única solicitação pendente/ativa por worker. Outra recebe `worker_busy`,
  sem alterar histórico nem reservar recursos. Admitir turno usa o coordenador
  do recorte 3; liberar estado busy também quando cancelar ainda na fila.
- Guardar transcript e metadados em diretório temporário privado (0700; arquivos
  0600), fora do workspace e do picker normal de sessões do Pi. Isso é escrita
  administrativa do coordenador/runtime, fora do escopo de mutações do worker.
  Históricos podem conter código e saídas; não compartilhar ou exportar.
- Duração limitada à sessão/instância atual. Troca de sessão/reload/encerramento
  invalida IDs; limpar somente artefatos próprios depois de encerrar filhos.
  Crash pode deixar resíduos privados: documentar limpeza, sem retomar ou tomar
  posse automaticamente. Não apagar arquivo ocupado ou seguir symlink na limpeza.
- Limites fixados: 16 workers por instância, 20 turnos por worker, 16 MiB por
  transcript. O limite de bytes é conferido antes/depois dos turnos, não uma quota
  de disco durante a execução. Históricos não são truncados/evictados. Limite ou
  corrupção impede retomada; `resumable: false` sinaliza indisponibilidade.
- Arquivo JSONL é precriado com header do SDK e modo 0600; spawn usa `--session`
  com caminho interno exato e `--session-dir` privado, sem fallback de ID ausente.
  `--model` fixa modelo explicitamente; mensagens/model_changes são conferidos
  contra a política. Somente headers v3 e árvores de entradas válidas são aceitos.
- Depois de falha/cancelamento, uma retomada explícita pode prosseguir com aviso
  de turno interrompido e histórico validado. Sem repetição automática do turno
  pelo orquestrador, inclusive retry do detector de loop. Retries internos de
  transporte do Pi/provedor não são desativados. Efêmeros conservam retry existente.
- `Delivery v1` permanece por turno e `acceptance: not_verified`. Anexar identidade,
  turno e referências às entregas anteriores; não transformar declaração antiga
  em aceite do turno atual nem inventar evidência cumulativa perdida.
- Pipeline/loop mantêm o comportamento efêmero atual; recebem coordenação, não
  retomada automática de runner/judge. Continuidade nesses fluxos é expansão
  posterior, evitando duplicar histórico e `{previous}` inadvertidamente.

## Ledger e unidades independentes

- [x] Conferir base e explorar os dois recortes em paralelo, somente leitura.
- [x] Conferir mecanismos relevantes no código/docs do Pi instalado.
- [x] Confirmar desenho, limites e armazenamento temporário com o usuário.
- [x] Coordenador fixou interfaces e leu SDK/sessões/formato/exemplos relevantes.
- [x] A: claims + coordenador + testes; fila cheia não bloqueia trabalho independente.
- [x] B: identidade/política + histórico privado + testes; canonicalização macOS,
  limpeza com ancestral substituído por symlink e lifecycle corrigidos após testes.
- [x] C: integração dos três orquestradores, schemas/config e erros.
- [x] D: 492 testes/31 arquivos; smoke SDK sem LLM e guardas (61 probes) aprovados;
  worker real retomado em dois turnos pelo launcher novo em processo isolado.
- [x] E: usuário confirmou `/reload` e teste funcional aprovado; commit autorizado.
  Confirmação do operador, não nova execução automatizada nem inspeção visual
  independente de `/se`. A recarga invalida IDs da instância anterior.

A e B começam juntos após interfaces confirmadas, sem dependência artificial.
Workers têm arquivos exclusivos, sem shell; coordenador executa testes.
C depende das APIs de A/B e tem propriedade exclusiva de index.ts. Planejamento
adicional de testes/documentação pode seguir sem esperar implementações. Nenhum
milestone termina só com lançamento ou declaração de worker: inspecionar saídas.

## Gates e resultados

- Baseline: 459 testes / 28 arquivos; final observado: **492 / 31**, sem falhas.
- `scripts/smoke-continuity.mjs`: SDK instalado abriu o mesmo transcript/ID,
  restaurou contexto e respeitou seleção de modelo/tools; scope só reduziu,
  modo 0600 preservado e limpeza conferida. Nenhuma chamada LLM nesse modo.
- Modo `--live`: task `bg_11hz_mw1bt0b1_1`, exit 0. Worker real lembrou nonce
  do turno anterior sem o nonce no segundo prompt e sem ler arquivos. Mesmo ID,
  turno 2, escopo herdado `[]`, zero escritas/comandos; descarte ao encerrar.
- `scripts/smoke-write-scope.mjs`: quatro cenários/61 probes aprovados no SDK real.
- Typecheck separado não executado: não há tsc instalado/disponível; nada instalado.
- Gates cobertos por testes abaixo (não implicam revisão independente ou UI):
- Recursos: concorrência real de promises controladas; conflitos de arquivos,
  diretórios e nomes; chamadas independentes iniciam antes de esperar; limite,
  equidade por conflito, cancelamento na fila, deadline, erro e liberação.
- Continuidade: criação/retomada verdadeira de histórico; IDs desconhecidos,
  posse, busy, modelo/perfil/cwd incompatíveis, redução e tentativa de ampliação;
  arquivos ausentes/corrompidos/links; interrupção e limpeza sem escapar da raiz.
- Integração com tools registrados e spawn simulado, não somente reimplementação
  dos conceitos. Pipeline/judge/cancelamento e chamadas antigas sem novos campos.
- SDK/CLI real em fixtures: mesmo transcript cresce, contexto é retomado, modelo
  esperado, política atual aplicada e nenhuma sessão do operador tocada.
- Suite completa, smoke fail-closed do recorte 2, whitespace/links, depois recarga
  e smoke com modelo. Não tratar chamadas pagas simuladas como runtime verificado.

[Checkpoint](../checkpoints/project-state.md) · [Índice](../README.md) ·
[Contrato atual](../../README.md#controlled-write-scope).
