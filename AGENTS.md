# Instruções para agentes neste fork

Antes de retomar trabalho, ler nesta ordem:
1. `docs/README.md`.
2. `docs/checkpoints/project-state.md`.
3. O plano ativo indicado no checkpoint.

A `main` é reservada para atualizações do repositório original. Trabalhar na
feature aprovada; não fazer merge, commit ou push sem autorização.

O Pi pode carregar este checkout diretamente: edições e trocas de branch
alteram a fonte da próxima recarga. Preservar a referência de rollback e não
recarregar o runtime durante ferramentas ativas.

Distinguir declarações do agente, resultados de ferramentas e aceite
verificado. Não chamar constraints ou filtros de shell de sandbox. Documentar
verificações não executadas. Ao fechar/pausar uma etapa, atualizar o checkpoint.
