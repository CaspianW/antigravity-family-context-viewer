import html from './dashboard.html';
import { handleRequest } from './api-core.mjs';

export default {
  fetch(request, env) {
    const statement = (sql, args) => {
      const prepared = env.DB.prepare(sql);
      return args.length ? prepared.bind(...args) : prepared;
    };
    const db = {
      async all(sql, ...args) { return (await statement(sql, args).all()).results; },
      async batch(statements) {
        const results = await env.DB.batch(statements.map(([sql, ...args]) => statement(sql, args)));
        return results.map(result => result.meta.changes);
      }
    };
    const secret = /^[!-~]{24,512}$/.test(env.FAMILY_SECRET || '') ? env.FAMILY_SECRET : null;
    return handleRequest(request, { db, secret, html, publicRead: env.FAMILY_PUBLIC_READ === '1' });
  }
};
