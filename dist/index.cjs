// Node storage adapter. Native dependencies stay explicit; no global fs patch.
var StorageMesh, StorageUnavailableError, createHost, crypto, digest, eligible, fs, path, provideStorage;

crypto = require('node:crypto');

fs = require('node:fs');

path = require('node:path');

StorageUnavailableError = class StorageUnavailableError extends Error {
  constructor(message, retryAfterMs) {
    super(message);
    this.retryAfterMs = retryAfterMs;
    this.name = 'StorageUnavailableError';
    this.code = 'EAGAIN';
  }

};

digest = function(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
};

eligible = function(file) {
  return !path.resolve(file).split(path.sep).some(function(part) {
    return part === '.database' || part === 'node_modules' || part === '.git';
  }) && !/\.(?:db|sqlite|sqlite3)$/i.test(file);
};

StorageMesh = class StorageMesh {
  constructor(options) {
    var dataDir, ref;
    this.root = path.resolve(options.root);
    dataDir = options.dataDir || path.join(this.root, '.logos', 'storage');
    fs.mkdirSync(dataDir, {
      recursive: true
    });
    this.dataFile = path.join(dataDir, 'catalog.json');
    this.provider = options.provider;
    this.retryAfterMs = (ref = options.retryAfterMs) != null ? ref : 5000;
    this.listeners = new Set();
    try {
      this.state = JSON.parse(fs.readFileSync(this.dataFile, 'utf8'));
    } catch (error1) {
      this.state = {
        records: {},
        outbox: []
      };
    }
    if (!(this.state.records && Array.isArray(this.state.outbox))) {
      this.state = {
        records: {},
        outbox: []
      };
    }
  }

  onEvent(listener) {
    this.listeners.add(listener);
    return () => {
      return this.listeners.delete(listener);
    };
  }

  setProvider(provider) {
    this.provider = provider;
  }

  status(file) {
    var value;
    value = this.state.records[path.resolve(file)];
    if (!value) {
      throw new Error(`storage record not found: ${file}`);
    }
    return {...value};
  }

  outbox() {
    return [...this.state.outbox];
  }

  persist() {
    var temp;
    temp = `${this.dataFile}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.state));
    fs.renameSync(temp, this.dataFile);
  }

  async emit(event, payload) {
    var listener;
    for (listener of this.listeners) {
      await listener(event, payload);
    }
  }

  async track(file) {
    var record, relative, resolved, stat;
    resolved = path.resolve(file);
    relative = path.relative(this.root, resolved);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`storage path is outside its managed root: ${file}`);
    }
    stat = fs.statSync(resolved);
    if (!stat.isFile()) {
      throw new Error(`storage can only track files: ${file}`);
    }
    record = {
      path: resolved,
      key: relative.split(path.sep).join('/'),
      sha256: digest(resolved),
      size: stat.size,
      state: 'pending',
      local: true,
      updatedAt: new Date().toISOString()
    };
    this.state.records[resolved] = record;
    if (!this.state.outbox.includes(resolved)) {
      this.state.outbox.push(resolved);
    }
    this.persist();
    await this.emit('storage:file-pending', {
      path: resolved,
      provider: this.provider && this.provider.name
    });
    return {...record};
  }

  async sync() {
    var error, file, i, len, record, ref, result;
    if (!this.provider) {
      return;
    }
    ref = [...this.state.outbox];
    for (i = 0, len = ref.length; i < len; i++) {
      file = ref[i];
      record = this.state.records[file];
      if (!(record && record.local && fs.existsSync(file))) {
        continue;
      }
      record.state = 'syncing';
      this.persist();
      try {
        result = (await this.provider.put({
          key: record.key,
          file,
          sha256: record.sha256,
          size: record.size
        }));
        if (result.sha256 !== record.sha256) {
          throw new Error('remote digest mismatch');
        }
        record.state = 'hot';
        delete record.lastError;
        this.state.outbox = this.state.outbox.filter(function(value) {
          return value !== file;
        });
        this.persist();
        await this.emit('storage:file-synced', {
          path: file,
          provider: this.provider.name,
          sha256: record.sha256
        });
      } catch (error1) {
        error = error1;
        record.state = 'pending';
        record.lastError = error.message || 'sync failed';
        this.persist();
        await this.emit('storage:sync-failed', {
          path: file,
          provider: this.provider.name,
          error: record.lastError
        });
      }
    }
  }

  async freeze(file) {
    var record, resolved;
    resolved = path.resolve(file);
    if (!eligible(resolved)) {
      throw new Error(`storage path is not eligible for freezing: ${file}`);
    }
    record = this.state.records[resolved];
    if (!record) {
      record = (await this.track(resolved));
    }
    if (!this.provider) {
      throw new Error('storage provider is not configured');
    }
    await this.sync();
    record = this.state.records[resolved];
    if (record.state !== 'hot') {
      record.state = 'failed';
      this.persist();
      throw new Error(record.lastError || 'remote object was not verified');
    }
    fs.unlinkSync(resolved);
    record.local = false;
    record.state = 'frozen';
    record.updatedAt = new Date().toISOString();
    this.persist();
    await this.emit('storage:file-frozen', {
      path: resolved,
      provider: this.provider.name,
      sha256: record.sha256
    });
    return {...record};
  }

  async ensure(file) {
    var content, error, record, resolved, temp;
    resolved = path.resolve(file);
    record = this.state.records[resolved];
    if (!record) {
      throw new Error(`storage record not found: ${file}`);
    }
    if (record.local && fs.existsSync(resolved)) {
      return {...record};
    }
    if (!this.provider) {
      throw new StorageUnavailableError('storage provider is not configured', this.retryAfterMs);
    }
    record.state = 'restoring';
    this.persist();
    try {
      content = (await this.provider.get({
        key: record.key
      }));
      if (crypto.createHash('sha256').update(content).digest('hex') !== record.sha256) {
        throw new Error('remote digest mismatch');
      }
      fs.mkdirSync(path.dirname(resolved), {
        recursive: true
      });
      temp = `${resolved}.restoring-${process.pid}`;
      fs.writeFileSync(temp, content);
      fs.renameSync(temp, resolved);
      record.local = true;
      record.state = 'hot';
      delete record.lastError;
      record.updatedAt = new Date().toISOString();
      this.persist();
      await this.emit('storage:file-ready', {
        path: resolved,
        provider: this.provider.name
      });
      return {...record};
    } catch (error1) {
      error = error1;
      record.state = 'degraded';
      record.lastError = error.message || 'rehydration failed';
      this.persist();
      await this.emit('storage:rehydration-pending', {
        path: resolved,
        provider: this.provider.name,
        retryAfterMs: this.retryAfterMs
      });
      throw new StorageUnavailableError(`storage rehydration pending: ${record.lastError}`, this.retryAfterMs);
    }
  }

};

provideStorage = function(host) {
  /*
  @register module storage
  @context capability
  */
  var mesh;
  mesh = void 0;
  return {
    name: 'storage',
    phase: 'boot',
    after: ['env'],
    api: {
      getStorage: (function() {
        return mesh;
      }),
      StorageMesh,
      StorageUnavailableError
    },
    install: function() {
      var config, root;
      config = host.storage.config();
      root = config.root || host.dataDir() || host.workspace();
      mesh = new StorageMesh({
        root,
        dataDir: config.dataDir,
        provider: config.provider,
        retryAfterMs: config.retryAfterMs
      });
      host.state('storage').set('mesh', mesh);
      mesh.onEvent(function(event, payload) {
        return host.emit(event, payload);
      });
      host.on('storage:ensure', async function(payload) {
        return {
          ...payload,
          storage: (await mesh.ensure(payload.path))
        };
      });
      host.on('storage:freeze', async function(payload) {
        return {
          ...payload,
          storage: (await mesh.freeze(payload.path))
        };
      });
      host.on('storage:track', async function(payload) {
        return {
          ...payload,
          storage: (await mesh.track(payload.path))
        };
      });
      host.on('storage:configure-provider', async function(payload) {
        if (!(payload && payload.provider && typeof payload.provider.put === 'function' && typeof payload.provider.get === 'function')) {
          throw new Error('invalid storage provider');
        }
        await mesh.setProvider(payload.provider);
        return {
          ...payload,
          configured: true,
          provider: payload.provider.name
        };
      });
    }
  };
};

createHost = function(...args) {
  return require('@thinkiac/module-runtime-compat').createHost(...args);
};

module.exports = {
  provideStorage,
  StorageMesh,
  StorageUnavailableError,
  createHost,
  createRuntimeModule: provideStorage
};
