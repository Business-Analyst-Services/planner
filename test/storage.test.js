'use strict';
// Runs the Redis backend against a tiny in-memory stand-in for the Upstash REST API.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { createRedisDb, createFileDb } = require('../lib/storage');

function fakeUpstash() {
  const kv = new Map(), sets = new Map();
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', c => (raw += c)); req.on('end', () => {
      if (req.headers.authorization !== 'Bearer t') { res.writeHead(401); return res.end('{"error":"unauthorized"}'); }
      const [cmd, ...a] = JSON.parse(raw);
      let result = null;
      if (cmd === 'MGET') result = a.map(k => kv.get(k) ?? null);
      else if (cmd === 'SCARD') result = (sets.get(a[0]) || new Set()).size;
      else if (cmd === 'EVAL') { // emulate the compare-and-set script
        const [, , k, vk, version, value, setKey] = a;
        if ((kv.get(vk) || '0') !== version) result = 0;
        else {
          if (value === '') kv.delete(k); else kv.set(k, value);
          kv.set(vk, String(Number(kv.get(vk) || 0) + 1));
          if (setKey) { const s = sets.get(setKey) || new Set(); value === '' ? s.delete(k) : s.add(k); sets.set(setKey, s); }
          result = 1;
        }
      } else { res.writeHead(400); return res.end(JSON.stringify({ error: 'unknown ' + cmd })); }
      res.end(JSON.stringify({ result }));
    });
  });
  return { server, kv };
}

for (const kind of ['redis', 'file']) {
  test(`${kind} storage: transactions retry instead of losing concurrent writes`, async () => {
    let db, close = () => {};
    if (kind === 'redis') {
      const { server } = fakeUpstash();
      await new Promise(r => server.listen(0, r));
      db = createRedisDb({ url: `http://127.0.0.1:${server.address().port}`, token: 't' });
      close = () => server.close();
    } else db = createFileDb(null);
    try {
      await Promise.all(Array.from({ length: 20 }, () => db.transact('counter', async s => {
        const n = (s.value?.n || 0);
        await new Promise(r => setTimeout(r, Math.random() * 10)); // widen the race window
        s.value = { n: n + 1 };
      })));
      assert.equal((await db.get('counter')).n, 20);
      assert.equal(await db.transact('counter', s => 'read only'), 'read only');
      await db.transact('board:x', s => { s.value = { a: 1 }; });
      if (kind === 'redis') assert.equal(await db.count('board:'), 1);
      await db.transact('board:x', s => { s.value = null; });
      assert.equal(await db.get('board:x'), null);
      if (kind === 'redis') assert.equal(await db.count('board:'), 0);
    } finally { close(); }
  });
}
