# Desenvolver e carregar o subagent local

Verificado em 2026-11-03: 492 testes; smokes do SDK e guardas; continuidade
com worker real em dois turnos no launcher novo via processo isolado. Usuário
confirmou recarga e teste funcional dos recortes 3 + 4. Dados persistidos de `/se`
conferidos no recorte 2; inspeção visual independente não realizada, não bloqueante.

## Premissas

Checkout `~/Projects/Agents/pi-subagents`, branch `feat/better-subagent`, criada
sobre `feat/show-subagent-edits` (`7d0f576`). A `main` fica reservada para
atualizações do upstream. Não instalar dependências, publicar ou modificar o
código do Pi como consequência deste procedimento.

O pacote local é carregado sem cópia. Qualquer troca de branch ou edição neste
checkout muda a fonte que será usada na próxima recarga. Não há isolamento por
branch Git na configuração global do Pi.

## Validar antes de ativar

1. Conferir `git status --short --branch` e preservar alterações do operador.
2. Rodar `npm test` e `git diff --check` com as dependências já instaladas.
3. Carregar `index.ts` e `tools/subagent-report.ts` com o loader da instalação
   real do Pi, sem fazer requisições a modelos. Exemplo (ajustar `PI_ROOT`):

```bash
PI_ROOT=/caminho/da/instalacao/@earendil-works/pi-coding-agent node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const { loadExtensions } = await import(pathToFileURL(`${process.env.PI_ROOT}/dist/core/extensions/loader.js`).href);
const cwd = process.cwd();
const result = await loadExtensions([`${cwd}/index.ts`, `${cwd}/tools/subagent-report.ts`], cwd);
assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
assert.deepEqual([...result.extensions[0].tools.keys()], ['subagent','pipeline','loop']);
assert(result.extensions[1].tools.has('subagent_report'));
console.log('Host Pi loader: OK; no model requests');
JS
```

4. Exercitar ferramentas protegidas e falhas de carga com o SDK instalado:

```bash
PI_SDK_ROOT=/caminho/da/instalacao/@earendil-works/pi-coding-agent \
  node scripts/smoke-write-scope.mjs
```

O script usa sessões em memória, turnos sintéticos e fixtures temporárias.
Verifica escrita/edição permitidas, bloqueio fora do escopo, escopo vazio,
proteção ausente/inválida e indisponibilidade de mutadores originais/custom/MCP,
inclusive via `ctx.executeTool`. Deve terminar com quatro cenários `PASS` e
61 probes; não chama modelos, não modifica settings e limpa suas fixtures.
Requer runtime com `ctx.executeTool` e `refreshContext`; não instalar/atualizar
SDK automaticamente se a dependência local for antiga. `PI_SDK_ROOT` seleciona
explicitamente a instalação que roda a sessão.

5. Validar continuidade com o SDK instalado, sem LLM:

```bash
PI_SDK_ROOT=/caminho/da/instalacao/@earendil-works/pi-coding-agent \
  node scripts/smoke-continuity.mjs
```

Confere mesmo transcript/ID/contexto restaurado, modelo/tools explícitos,
redução permanente de escopo, permissões 0600 e limpeza. Para smoke com worker
real, **quando autorizado a consumir modelo**, acrescentar `--live`: são dois
turnos de worker, podendo envolver várias requisições por turno. O segundo
recupera um nonce do primeiro sem o nonce no prompt e sem ler arquivos. Usa o
perfil `worker` atual e seu provedor; não instalar/alterar credenciais por falha.
O script isola o launcher novo; não recarrega a sessão interativa do operador.

O caminho interno do loader pode mudar entre versões do Pi. Isso é smoke de
carregamento, não uma chamada real de modelo, revisão humana ou teste visual
interativo. Os testes de orquestração usam eventos/processos simulados.

## Ativar o checkout

1. Guardar uma cópia privada de `~/.pi/agent/settings.json` em
   `~/.pi/agent/backups/` antes de editar.
2. Substituir **somente** a entrada do pacote:

```text
git:github.com/augustoedt/pi-subagents@7d0f576f142db4455d86dd42cedd8f1030110a32
```

por:

```text
/Users/augusto/Projects/Agents/pi-subagents
```

Não adicionar ambas as fontes: isso pode carregar duas cópias da extensão.
Preservar todos os demais pacotes, provedores e preferências.
3. Após a sessão ficar ociosa, executar `/reload` ou abrir uma nova sessão.
4. Conferir `resources` e `write_scope` nos três tools (por passo no pipeline),
   e `continuity` somente em `subagent`, além dos campos de contexto. Se autorizado a gastar uma chamada, testar um scout
   somente leitura e conferir `Delivery v1`, sem confundir declaração com
   comprovação. A ferramenta `subagent_report` é carregada somente nos filhos,
   não como ferramenta pública adicional do coordenador.

Alterar settings não troca retroativamente o runtime desta conversa.

## Rollback

Substituir apenas a entrada local pela referência fixada em `7d0f576` acima,
e então `/reload`. Não restaurar todo o backup por cima de configurações
posteriores: comparar primeiro. Não é necessário trocar a branch do checkout,
apagar resultados ou resetar mudanças locais.

## Limites e diagnóstico

- `Unknown declared tool` ou extensão ausente: corrigir o mapeamento/instalação
  separadamente; não retirar ferramentas exigidas silenciosamente.
- Pré-requisitos validam tipos de config, cwd, resolução estrutural de modelo
  e arquivos das extensões. Não comprovam credenciais, disponibilidade do
  provedor ou registro dinâmico de uma ferramenta.
- `not_reported` não significa entrega aceita. `acceptance: not_verified` é
  intencional; o coordenador ainda deve conferir o trabalho e as verificações.
- Probes de bloqueio esperados podem produzir `observed.incomplete: true`:
  o coletor marca qualquer mutação falha conservadoramente. Conferir a sentinela,
  escritas observadas e metadados das edições; não inferir sucesso pela declaração.
- `constraints` não impõe escopo. `write_scope` controla mutações pelas ferramentas,
  sem shell/subdelegação; builds/testes ficam no coordenador. Não é isolamento OS,
  confinamento de leitura, lock compartilhado nem pinagem de identidade/inode.
- Escopo ausente preserva o perfil; `[]` nega escritas. Diretórios de escopo já
  devem existir antes do pipeline; `PI_SUBAGENT_WRITE_SCOPE` não pode vir de envExtra.
- Recursos só coordenam irmãos na instância atual. Escritores sem escopo ficam
  serializados; readonly não ganha snapshot consistente. Espera tem duração/motivo
  próprios, separados do timeout do filho; maxQueueDepth=64 e queueTimeoutMs=0.
- Workers retomáveis exigem escopo, agente/modelo/perfil/cwd compatíveis e histórico
  válido. `worker_busy` significa outro turno pendente/ativo; aguardar seu resultado,
  não criar chamadas concorrentes para o mesmo ID. Escopo reduzido não reabre.
- Reload/troca de sessão/restart invalida IDs. Não importar JSONL de outro worker
  nem tratar ID ausente como criação silenciosa. Limites: 16 workers, 20 turnos,
  16 MiB de transcript conferidos entre turnos; sem eviction/truncamento automático.
- Históricos temporários ficam sob `os.tmpdir()/pi-worker-sessions-*`, fora do
  workspace e do picker normal. Encerramento normal limpa somente artefatos próprios
  após o filho terminar. Crash pode deixar resíduos: antes de remover manualmente,
  identificar o diretório da execução encerrada e confirmar ausência de processo
  usando-o. Nunca varrer/apagar o prefixo inteiro nem seguir links simbólicos;
  não há takeover ou retomada pós-crash. Conteúdo pode ser sensível.
- Alertas de background pertencem à outra extensão; este pacote não os corrige.

Estado/evidência atual: [checkpoint](../checkpoints/project-state.md).
