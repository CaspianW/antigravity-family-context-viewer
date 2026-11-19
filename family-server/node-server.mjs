import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { handleRequest } from './api-core.mjs';

const html = () => readFileSync(new URL('./dashboard.html', import.meta.url), 'utf8');
const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

export function createFamilyServer({ database = ':memory:', secret, publicRead = false, now } = {}) {
  const sqlite = new DatabaseSync(database);
  sqlite.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL;');
  sqlite.exec(schema);
  const db = {
    all(sql, ...args) { return sqlite.prepare(sql).all(...args); },
    batch(statements) {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const changes = statements.map(([sql, ...args]) => Number(sqlite.prepare(sql).run(...args).changes));
        sqlite.exec('COMMIT');
        return changes;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    }
  };
  const server = createServer(async (incoming, outgoing) => {
    try {
      const method = incoming.method;
      const origin = 'http://localhost';
      const request = new Request(new URL(incoming.url, origin), {
        method, headers: incoming.headers,
        ...(method === 'GET' || method === 'HEAD' ? {} : { body: Readable.toWeb(incoming), duplex: 'half' })
      });
      const response = await handleRequest(request, { db, secret, publicRead, html: method === 'GET' && new URL(request.url).pathname === '/' ? html() : '', now });
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) Readable.fromWeb(response.body).pipe(outgoing);
      else outgoing.end();
    } catch {
      if (!outgoing.headersSent) outgoing.writeHead(400);
      outgoing.end();
    }
  });
  server.on('close', () => sqlite.close());
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const secret = process.env.FAMILY_SECRET;
  if (!secret || secret.length < 24 || secret.length > 512 || /[^!-~]/.test(secret)) {
    console.error('Set FAMILY_SECRET to 24–512 printable ASCII characters without spaces.');
    process.exitCode = 1;
  } else {
    const server = createFamilyServer({
      database: process.env.FAMILY_DATABASE || 'family-data.sqlite',
      secret,
      publicRead: process.env.FAMILY_PUBLIC_READ === '1'
    });
    const hostname = process.env.FAMILY_HOST || '127.0.0.1';
    server.listen(Number(process.env.PORT || 8787), hostname, () => {
      const { address, port } = server.address();
      console.log(`Family dashboard listening at http://${address.includes(':') ? '[' + address + ']' : address}:${port}`);
    });
  }
}
