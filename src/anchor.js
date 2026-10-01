'use strict';

// External anchor for the audit chain.
//
// A hash chain exposes an edited or removed row *inside* the chain, but not the
// removal of the newest rows: a truncated chain is still a valid chain. The
// anchor closes that gap by keeping, outside the database, the latest
// { row count (seq), head hash } of every organisation's chain, signed with an
// HMAC key the database never sees. The verifier checks the live chain against
// it: a chain that ends before the anchored seq, or has a different hash at
// that seq, has been truncated or rewritten.
//
// One JSON file per (database, organisation), replaced atomically. Anchors only
// move forward. This is deliberately small: the same host that runs the service
// can write here, so it protects against tampering through the database, not
// against an attacker who holds both the host and ANCHOR_KEY.

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const SAFE = /^[A-Za-z0-9_]+$/;

class AnchorStore {
  constructor({ dir, key }, database) {
    if (!SAFE.test(database)) throw new Error(`invalid anchor scope "${database}"`);
    this.dir = dir;
    this.key = key;
    this.database = database;
    this.queues = new Map(); // orgId -> promise chain: serialises writes per org in this process
  }

  file(orgId) {
    return path.join(this.dir, `${this.database}.org-${Number(orgId)}.json`);
  }

  mac(a) {
    return crypto.createHmac('sha256', this.key)
      .update(`${a.database}\n${a.org_id}\n${a.seq}\n${a.hash}\n${a.anchored_at}`).digest('hex');
  }

  /** Reads and authenticates an anchor. Never throws. */
  async read(orgId) {
    let text;
    try {
      text = await fs.readFile(this.file(orgId), 'utf8');
    } catch (err) {
      return err.code === 'ENOENT' ? { status: 'missing' } : { status: 'unreadable', reason: err.code || 'read failed' };
    }
    let a;
    try { a = JSON.parse(text); } catch { return { status: 'invalid', reason: 'anchor file is not valid JSON' }; }
    const expected = this.mac(a);
    const given = typeof a.mac === 'string' ? a.mac : '';
    const ok = given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
    if (!ok || a.database !== this.database || a.org_id !== Number(orgId)) {
      return { status: 'invalid', reason: 'anchor signature does not match its content' };
    }
    return { status: 'ok', anchor: { seq: a.seq, hash: a.hash, anchored_at: a.anchored_at } };
  }

  /**
   * Records a new chain head. Called only after the transaction that wrote the
   * head has committed. Returns true when the anchor now covers `seq`.
   */
  record(orgId, { seq, hash }) {
    const prev = this.queues.get(orgId) || Promise.resolve();
    const next = prev.then(async () => {
      const current = await this.read(orgId);
      if (current.status === 'ok' && current.anchor.seq >= seq) return true; // never move backwards
      if (current.status === 'invalid') return false; // do not paper over a tampered anchor
      const a = { database: this.database, org_id: Number(orgId), seq, hash, anchored_at: new Date().toISOString() };
      await this.writeAtomic(orgId, { ...a, mac: this.mac(a) });
      return true;
    }).catch(() => false);
    this.queues.set(orgId, next);
    return next;
  }

  async writeAtomic(orgId, obj) {
    await fs.mkdir(this.dir, { recursive: true });
    const target = this.file(orgId);
    const tmp = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    const fh = await fs.open(tmp, 'w');
    try {
      await fh.writeFile(`${JSON.stringify(obj)}\n`);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fs.rename(tmp, target);
  }

  /** Readiness probe: the anchor directory exists and is writable. */
  async probe() {
    const p = path.join(this.dir, `.probe-${process.pid}`);
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(p, 'ok');
    await fs.unlink(p);
  }

  /** Removes every anchor of this database (used when the database is recreated). */
  async clear() {
    let names = [];
    try { names = await fs.readdir(this.dir); } catch { return; }
    await Promise.all(names.filter(n => n.startsWith(`${this.database}.org-`)).map(n => fs.unlink(path.join(this.dir, n))));
  }
}

module.exports = { AnchorStore };
