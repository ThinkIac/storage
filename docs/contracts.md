# Contratos e migração

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

## Integração na base

Substitua a dependência file: pelo repositório fixado em commit. Preserve as
fachadas index/compat para imports existentes. Para rollback, restaure a
referência anterior e o lockfile e reinstale antes de iniciar o host. Não
misture gerações reiniciando capacidades isoladas no processo ativo.
