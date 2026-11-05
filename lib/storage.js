'use strict';
// Storage for Daycraft's server data, as named JSON records with optimistic concurrency.
//
//   db.transact(key, state => { ...read/modify state.value...; return result })
//
// loads the record, runs the function, and writes it back only if it changed. If another
// request wrote the record in the meantime the write is refused and the function re-runs on
// fresh data, so concurrent requests never overwrite each other.
//
// Backends:
//   - File (default): one JSON file, for local use and Docker. Single process.
//   - Vercel Blob (used on Vercel): a private Blob store connected to the project sets
//     BLOB_STORE_ID (OIDC auth) or BLOB_READ_WRITE_TOKEN. Conditional writes (ETag ifMatch) give compare-and-set.
//   - Upstash Redis REST: set KV_REST_API_URL + KV_REST_API_TOKEN
//     (or UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN).

const fs = require('node:fs');
const path = require('node:path');

class ConflictError extends Error {}

async function transactWith(load, write, key, fn, attempts = 6) {
  for (let i = 0; i < attempts; i++) {
    const { value, version } = await load(key);
    const before = value === null ? null : JSON.stringify(value);
    const state = { value: value === null ? null : JSON.parse(before) };
    const result = await fn(state);
    const after = state.value === null || state.value === undefined ? null : JSON.stringify(state.value);
    if (after === before) return result;
    try { await write(key, version, after); return result; }
    catch (e) {
      if (!(e instanceof ConflictError)) throw e;
      await new Promise(r => setTimeout(r, 15 + Math.random() * 40 * (i + 1)));
    }
  }
  throw Object.assign(new Error('The server is busy. Please try again.'), { status: 503 });
}

// ---------- file ----------
function createFileDb(file) {
  let records = {}, versions = {};
  if (file && fs.existsSync(file)) {
    let raw;
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Error(`Could not read data file ${file}: ${e.message}`); }
    if (raw && raw.records) records = raw.records;
    else if (raw) { // first-version format: one object with My Group fields and a boards map
      const { boards = {}, ...circle } = raw;
      records.circle = circle;
      for (const [id, b] of Object.entries(boards)) records['board:' + id] = b;
    }
  }
  const persist = () => {
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ format: 2, records }));
    fs.renameSync(tmp, file);
  };
  const load = async key => ({ value: key in records ? records[key] : null, version: versions[key] || 0 });
  const write = async (key, version, json) => {
    if ((versions[key] || 0) !== version) throw new ConflictError();
    if (json === null) delete records[key]; else records[key] = JSON.parse(json);
    versions[key] = version + 1;
    persist();
  };
  return {
    kind: 'file',
    transact: (key, fn) => transactWith(load, write, key, fn),
    get: async key => (await load(key)).value,
    count: async prefix => Object.keys(records).filter(k => k.startsWith(prefix)).length,
  };
}

// ---------- Upstash Redis (REST) ----------
const CAS = `local v = redis.call('GET', KEYS[2]) or '0'
if v ~= ARGV[1] then return 0 end
if ARGV[2] == '' then redis.call('DEL', KEYS[1]) else redis.call('SET', KEYS[1], ARGV[2]) end
redis.call('INCR', KEYS[2])
if ARGV[3] ~= '' then
  if ARGV[2] == '' then redis.call('SREM', ARGV[3], KEYS[1]) else redis.call('SADD', ARGV[3], KEYS[1]) end
end
return 1`;

function createRedisDb({ url, token, prefix = 'daycraft:' }) {
  const call = async (command) => {
    const res = await fetch(url.replace(/\/$/, ''), { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(command) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.error) throw new Error('Storage error: ' + (json.error || res.status));
    return json.result;
  };
  const k = key => prefix + key;
  const setFor = key => (key.startsWith('board:') ? prefix + 'index:boards' : '');
  const load = async key => {
    const [value, version] = await call(['MGET', k(key), k(key) + ':v']);
    return { value: value == null ? null : JSON.parse(value), version: Number(version || 0) };
  };
  const write = async (key, version, json) => {
    const ok = await call(['EVAL', CAS, '2', k(key), k(key) + ':v', String(version), json === null ? '' : json, setFor(key)]);
    if (Number(ok) !== 1) throw new ConflictError();
  };
  return {
    kind: 'redis',
    transact: (key, fn) => transactWith(load, write, key, fn),
    get: async key => (await load(key)).value,
    count: async prefixKey => (prefixKey === 'board:' ? Number(await call(['SCARD', prefix + 'index:boards'])) : 0),
  };
}

// ---------- Vercel Blob (private store) ----------
// `client` defaults to the @vercel/blob SDK; tests pass a fake with the same shape.
function createBlobDb({ token, prefix = 'daycraft/', client = require('@vercel/blob') } = {}) {
  const { get, put, del, list, BlobPreconditionFailedError } = client;
  const auth = token ? { token } : {};
  const pathOf = key => prefix + key.replace(/:/g, '/') + '.json';
  const conflict = e => e instanceof BlobPreconditionFailedError || /already exists|precondition/i.test(String(e?.message));
  const load = async key => {
    const result = await get(pathOf(key), { access: 'private', useCache: false, ...auth });
    if (!result || result.statusCode !== 200 || !result.stream) return { value: null, version: null };
    const text = await new Response(result.stream).text();
    return { value: JSON.parse(text), version: result.blob.etag };
  };
  const write = async (key, version, json) => {
    try {
      if (json === null) { if (version) await del(pathOf(key), { ifMatch: version, ...auth }); return; }
      await put(pathOf(key), json, {
        access: 'private', addRandomSuffix: false, contentType: 'application/json', cacheControlMaxAge: 60,
        ...(version ? { ifMatch: version, allowOverwrite: true } : { allowOverwrite: false }), ...auth,
      });
    } catch (e) {
      if (conflict(e)) throw new ConflictError();
      throw e;
    }
  };
  return {
    kind: 'blob',
    transact: (key, fn) => transactWith(load, write, key, fn),
    get: async key => (await load(key)).value,
    count: async keyPrefix => {
      let n = 0, cursor;
      do {
        const page = await list({ prefix: pathOf(keyPrefix).replace(/\.json$/, ''), limit: 1000, cursor, ...auth });
        n += page.blobs.length; cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor);
      return n;
    },
  };
}

function dbFromEnv(env = process.env, { file } = {}) {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) return createRedisDb({ url, token, prefix: env.DAYCRAFT_PREFIX || 'daycraft:' });
  // A store connected in the Vercel dashboard sets BLOB_STORE_ID and authenticates with the
  // function's OIDC token (no secret); older stores set BLOB_READ_WRITE_TOKEN instead.
  if (env.BLOB_READ_WRITE_TOKEN || env.BLOB_STORE_ID) return createBlobDb({ token: env.BLOB_READ_WRITE_TOKEN || undefined, prefix: env.DAYCRAFT_BLOB_PREFIX || 'daycraft/' });
  if (env.VERCEL) return null; // no writable disk on Vercel: storage must be configured
  return createFileDb(file || env.DATA_FILE || path.join(__dirname, '..', 'data', 'daycraft.json'));
}

module.exports = { createFileDb, createRedisDb, createBlobDb, dbFromEnv, ConflictError };
