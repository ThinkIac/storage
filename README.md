# @thinkiac/module-storage

Capacidade storage do Lógos migrada para LogosType (`.type`). Mantém os contratos
existentes, sem acrescentar eventos ou alterar permissões.

```sh
npm install ThinkIac/storage#main
npm test
npm run test:isolated
```

Para composição reproduzível, fixe o commit em vez de `main`.

## Estrutura

- `src/*.type`: implementação mantida em LogosType.
- `dist/*.cjs`: artefatos compilados, incluídos na distribuição.
- `index.cjs`: entrada CommonJS compatível.
- `compat/`: wrappers públicos legados preservados para o SDK runtime-compat.
- `test/reference/`: fontes anteriores usados somente nos testes comparativos.
- `scripts/`: build e instalação isolada sem compilador no consumidor.

O registro declarativo `@register module` usa o contexto capability do Lógos.
`createHost` vem de `@thinkiac/module-runtime-compat`, fixado por commit.
`createRuntimeModule` permanece como alias de biblioteca para consumidores atuais.
O compilador [LogosType](https://github.com/ThinkIac/LogosType) é dependência de
build. Carregar o pacote distribuído não exige o compilador.

## Armazenamento local primeiro

`provideStorage(host)` instala na fase `boot`, opcionalmente após `env`.
A API contém `getStorage()`, `StorageMesh` e `StorageUnavailableError`.
O host fornece `storage.config()`, `dataDir()`, `workspace()`, estado e eventos.
Configuração: `root`, `dataDir`, `provider` e `retryAfterMs` (padrão 5000).

```js
const { StorageMesh } = require('@thinkiac/module-storage');
const storage = new StorageMesh({ root: '/dados', provider });
await storage.track('/dados/relatorio.txt');
await storage.sync();
await storage.freeze('/dados/relatorio.txt');
await storage.ensure('/dados/relatorio.txt');
```

O provedor deve oferecer `name`, `put({key,file,sha256,size})` retornando
`{sha256}` e `get({key})` retornando conteúdo aceito pelo Node crypto/fs.
A implementação não impõe um backend remoto. O adaptador S3 legado continua
na distribuição Lógos, acessado pelo wrapper de compatibilidade.

```text
track → pending + catálogo/outbox persistidos
sync → syncing → hot (digest confirmado) ou pending (falha)
freeze → sincroniza/verifica → remove cópia local → frozen
ensure → restoring → hot ou degraded + EAGAIN
```

`status(file)` e `outbox()` retornam cópias rasas. `onEvent(listener)` retorna
uma função para remover a inscrição. O catálogo fica por padrão em
`<root>/.logos/storage/catalog.json`, gravado por arquivo temporário e rename.
Catálogo inválido é reiniciado vazio, preservando o comportamento anterior.
Arquivos fora da raiz não podem ser rastreados. Freeze rejeita bancos locais,
`.database`, `node_modules` e `.git`. A cópia local só é removida após confirmação
do SHA-256 remoto. Restauração inválida não publica o conteúdo corrompido.

Eventos de entrada: `storage:track`, `storage:freeze`, `storage:ensure` recebem
`{path,...}` e devolvem o payload com `storage`. `storage:configure-provider`
recebe `{provider}`, valida put/get e devolve `configured:true` e seu nome.

Notificações: `storage:file-pending`, `storage:file-synced`,
`storage:sync-failed`, `storage:file-frozen`, `storage:file-ready` e
`storage:rehydration-pending`. Falha de restauração lança
`StorageUnavailableError` com `code: EAGAIN` e `retryAfterMs`.

## Limites e ciclo de vida

Depende de Node fs/path/crypto e process.pid; não substitui `fs` global, não
implementa FUSE nem promete portabilidade embarcada. Mantém as verificações de
caminho originais; não acrescenta isolamento por symlink ou controle concorrente.
Não cria conexão nem timer próprio. Listeners pertencem ao ciclo do host.

## Validação

A CI executa build, testes de comportamento e instalação isolada em Node 18,
20 e 22. Testes comparam respostas, falhas e eventos com os fontes anteriores.
Isso comprova os casos exercitados, não equivalência para toda entrada possível.
