# Estado do projeto

Atualizado em 2026-11-03. Checkpoint autoritativo deste fork.

## Estado atual

- Branch de trabalho: `feat/better-subagent`, derivada de
  `feat/show-subagent-edits` em `7d0f576`.
- Primeiro recorte implementado e validado; commit local autorizado pelo
  usuário, **sem push**. `main` continua em `69d7ea6`, reservada para receber
  atualizações do repositório original.
- Pi configurado para carregar `/Users/augusto/Projects/Agents/pi-subagents`.
  Somente a entrada do pacote foi substituída; demais settings preservados.
- **A sessão ativa ainda precisa de `/reload` ou reinício.** Configuração em
  disco e loader testado não comprovam recarga do runtime desta conversa.

## Implementado

- `context_files`, `acceptance` e `constraints` opcionais em `subagent`, por
  passo de `pipeline` e no `loop` (runner e judge); chamadas antigas preservadas.
- Referências canônicas a arquivos existentes, sem injeção automática do
  conteúdo. Contexto não concede permissões; constraints não são sandbox.
- Ferramenta interna `subagent_report` para declaração do filho, separada de
  evidências observadas de `edit`/`write`/`bash`/`safe_bash`.
- `Delivery v1` em metadados e resumo textual para o modelo. Aceite permanece
  `not_verified`; exit zero ou YES do judge não comprovam testes aprovados.
- Memória limitada, omissões/truncamentos explícitos, caminho de log somente
  quando fornecido pela ferramenta. Escritas via shell/descendentes não são
  inventariadas como diff completo. Evidência não é apagada no retry.
- Pré-requisitos de cwd, resolução estrutural de modelo, mapeamento/arquivo
  das ferramentas e tipos de configuração; erro explícito antes do spawn.
- Regressões corrigidas na integração: retry reconstrói prompt temporário;
  cancelamento e judge com erro não são aceitos como conclusão bem-sucedida;
  falha de pré-requisito posterior preserva resultados anteriores da pipeline.

## Evidência

- Baseline: 360 testes aprovados.
- Final: **424 testes aprovados em 25 arquivos**, `npm test`.
- `git diff --check` aprovado.
- Loader da instalação real do Pi carregou a extensão e o reporting tool sem
  erros. Preflight real, cancelado antes do spawn: worker/scout/reviewer OK.
- Testes de orquestração exercitam os tools registrados com eventos/processos
  simulados; não houve chamada de modelo usando a versão nova nem teste visual
  interativo após recarga. Nenhuma instalação de dependências.
- Backup privado dos settings anteriores:
  `~/.pi/agent/backups/settings-before-better-subagent-20261103T220625Z.json`.
  Comparação JSON confirmou alteração exclusiva da referência do pacote.

## Pendência conhecida

`researcher` exige `web_search`, que não está mapeado nesta instalação. O novo
preflight bloqueia sua execução explicitamente. Não instalar extensões nem
retirar ferramentas do perfil sem autorização; worker/scout/reviewer não
estão bloqueados por essa ausência. Pré-requisitos não comprovam credenciais,
disponibilidade do provedor nem registro dinâmico de extensões arbitrárias.

## Próximo passo e limites

1. Operador executar `/reload` ou abrir nova sessão; confirmar campos novos e
   fazer smoke somente leitura se autorizar chamada de modelo.
2. Publicação da branch e revisão independente dependem de autorização.
3. Próximos recortes exigem aceite: escopo de escrita imposto, isolamento,
   locks de recursos, continuidade de sessões e melhorias adicionais do `/se`.
   Alertas de background são responsabilidade de outra extensão.

[Plano/ledger](../plans/better-subagent.md) ·
[Ativação, validação e rollback](../runbooks/desenvolvimento-local.md) ·
[Índice](../README.md).
