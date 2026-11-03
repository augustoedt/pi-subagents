# Documentação do fork

## Como navegar

Ler [estado atual](checkpoints/project-state.md). Não há plano ativo de código;
recorte 2 concluído, recarregado, exercitado com worker real e commitado com
autorização. Publicação/push não autorizados.
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

Reservada a planos vivos. Nenhum recorte adicional aprovado para implementação.

## archive/

Planos concluídos, preservados como histórico, não como roteiro ativo:
[primeiro recorte](archive/better-subagent.md) e
[escopo de escrita — recorte 2](archive/write-scope.md).

## runbooks/

Procedimentos de desenvolvimento e operação local:
[desenvolvimento-local.md](runbooks/desenvolvimento-local.md).
