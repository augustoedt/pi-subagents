# Documentação do fork

## Como navegar

Ler [estado atual](checkpoints/project-state.md). Recortes 1 a 4 concluídos,
commitados e recarregados; usuário confirmou teste funcional dos recortes 3 + 4.
Não há plano ativo de implementação. Publicação/push não autorizados.
O [README principal](../README.md) é a referência pública do contrato.

| Antes de… | Leia |
| --- | --- |
| Testar, recarregar ou reverter o checkout | [Runbook local](runbooks/desenvolvimento-local.md) |
| Delegar edições com escopo | [Contrato de escrita](../README.md#controlled-write-scope) |
| Retomar ou publicar trabalho | [Checkpoint e autorizações](checkpoints/project-state.md) |

| Fonte | Responsabilidade |
| --- | --- |
| README principal | Uso, schema e limites das ferramentas |
| Checkpoint | Estado autoritativo, validações e próximo passo |
| Plano | Escopo autorizado e ledger de execução |
| Runbook | Reproduzir validação, ativar checkout local e reverter |

## checkpoints/

Um único checkpoint para retomar trabalho:
[project-state.md](checkpoints/project-state.md).

## plans/

Reservada a planos vivos. Nenhum novo recorte aprovado; a utilidade da evolução
do histórico/explorer será reavaliada antes de planejar implementação.

## archive/

Planos concluídos, preservados como histórico, não como roteiro ativo:
[primeiro recorte](archive/better-subagent.md),
[escopo de escrita — recorte 2](archive/write-scope.md) e
[coordenação e continuidade — recortes 3 + 4](archive/coordenacao-e-continuidade.md).

## runbooks/

Procedimentos de desenvolvimento e operação local:
[desenvolvimento-local.md](runbooks/desenvolvimento-local.md).
