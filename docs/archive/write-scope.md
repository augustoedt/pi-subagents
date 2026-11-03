# Recorte 2 — escopo de escrita controlado

## Estado e autorização

Usuário autorizou iniciar o recorte 2 na `feat/better-subagent`, sobre `0874e63`.
Exploração concluída com scout no formato novo. Usuário confirmou a política
abaixo e autorizou implementar: modo com escopo sem shell/subdelegação.
Implementação concluída e validada: 459 testes e smoke do SDK instalado com
61 probes, sem chamadas a modelos. Ativação interativa requer novo `/reload`.
Sem commit/push automático, alteração do Pi core ou mudança de `main`.

## Política aprovada

- Campo opcional `write_scope` em subagent, em cada passo de pipeline e no loop.
  Sem o campo, comportamento atual permanece.
- Forma implementada: lista de `{path, kind: "file" | "directory"}`, sem glob nesta
  versão. Arquivos exatos podem ser novos se o diretório pai existir;
  diretórios de escopo devem existir e autorizam seus descendentes.
- Escopo vazio representa nenhuma escrita, nunca acesso irrestrito.
- No modo com escopo: manter leitura local e relatório; substituir apenas
  mutadores declarados pelo agente por `scoped_edit`/`scoped_write`.
  Desabilitar shell, execução de código, ferramentas customizadas arbitrárias
  e subdelegação, com aviso explícito ao agente e ao coordenador.
- Builds/testes ficam a cargo do coordenador. Não fingir suporte a comandos
  seguros via regex: `safe_bash` não é sandbox.
- Caminhos canônicos por operação; barrar saídas por `..`, links simbólicos,
  caminhos com segmento `.git` e arquivos com múltiplos hardlinks. Permitir
  criação de subdiretórios somente dentro do escopo autorizado.
- Falha ao carregar a proteção não pode restaurar mutadores irrestritos:
  ferramentas com nomes próprios e lista de ferramentas permitidas/excluídas.
- Restrições técnicas não podem ser ampliadas por texto, envExtra, retry,
  judge ou delegação indireta. Sem nova permissão para agentes somente leitura.

A proteção é no limite das ferramentas, **não isolamento do sistema operacional**.
Extensões de provedor carregadas são código confiável; processos externos,
races entre processos e extensões hostis não ficam isolados por essa política.
Testes devem explicitar limites, não prometer ausência absoluta de TOCTOU.

## Evidência e decisões técnicas

Scout executado com `context_files`, `acceptance` e `constraints`; retornou
`Delivery v1`, declaração complete, nenhuma escrita/comando observado e aceite
não verificado. Coordenador conferiu pontos críticos no runtime real:
`createWriteToolDefinition`/`createEditToolDefinition` aceitam operações injetadas
dentro da fila de mutações e recebem caminho resolvido pelo Pi; listas de
permissão/exclusão filtram o registro de ferramentas. Reimplementar o resolvedor
no wrapper ou substituir somente o nome builtin pode abrir caminhos de bypass.
Validação executada: 459 testes em 28 arquivos; operações reais em fixtures;
smoke do SDK instalado com 61 chamadas aninhadas em turnos sintéticos,
incluindo guardas ausentes/inválidos e tentativa de usar mutadores originais,
custom tools e MCP. Nenhuma chamada a modelo nesse smoke.

A análise adicional levantou pinagem de identidade/inode do diretório. O contrato
é por **caminho canônico**, não identidade do objeto: recriar um diretório no
mesmo caminho autorizado não amplia o escopo; o caminho movido não recebe a
permissão. Essa decisão está explícita em teste e README. Troca por symlink para
outro caminho é bloqueada. Não se trata de lock ou snapshot de filesystem.

Ainda não verificados: uso interativo de `/se` com `scoped_edit`, delegação real
com o schema novo após recarga e outras plataformas. O smoke usa SDK real com
turnos simulados, não um subprocesso controlado por modelo.

## Ledger e unidades

- [x] Confirmar branch/base limpa e uso real do novo contrato pelo scout.
- [x] Explorar pontos de integração e conferir mecanismos no runtime instalado.
- [x] Confirmar política restrita sem shell/subdelegação.
- [x] U1: modelo, canonicalização e validação de escopo + testes de filesystem.
- [x] U2: ferramentas protegidas + testes reais de operações; depende de U1.
- [x] U3: plano de lançamento restrito + propagação/env; depende de U1.
- [x] U4: integração dos três orquestradores; depende de U2/U3.
- [x] U5: reconhecer os nomes protegidos em evidência, diffs e `/se` + testes.
- [x] Gates completos, smoke fail-closed e documentação/limites.

U1 (worker de política) e U5 (worker de nomes/evidências) iniciam juntos, com
arquivos exclusivos; a análise de integração do coordenador é independente.
U2 e U3 podem seguir em paralelo após estabilizar U1; coordenador
possui `index.ts` e a integração. Sem testar contra arquivos reais do operador:
usar fixtures temporárias, incluindo symlinks/hardlinks e falhas de carga.

Aceite: alterações fora do escopo bloqueadas antes de mutação pelas ferramentas;
falhas de proteção não liberam write/edit originais; chamadas sem escopo
preservadas; leitura não implica permissão de escrita; registros não confundem
bloqueio, declaração e testes executados. Nenhum teste/test runner automático
pelo worker restrito.

[Checkpoint](../checkpoints/project-state.md) · [Índice](../README.md).
