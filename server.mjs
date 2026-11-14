import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { renderHome, renderMachine } from './score-pages.mjs';

const configPath = resolve(process.argv[2] ?? fileURLToPath(new URL('./config.json', import.meta.url)));
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const usersPage = readFileSync(new URL('./users.html', import.meta.url));
const scoreStyles = readFileSync(new URL('./score-pages.css', import.meta.url));
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const insiderPattern = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const games = new Map(Object.entries(config.games));
const machineImages = new Map();

for (const [slug, name] of games) {
  if (!slugPattern.test(slug) || typeof name !== 'string' || !name.trim()) {
    throw new Error(`Invalid game configuration for "${slug}"`);
  }
}

for (const [slug, filename] of Object.entries(config.machine_images ?? {})) {
  if (!games.has(slug) || typeof filename !== 'string' || !/^[\w-]+\.png$/i.test(filename)) continue;
  try {
    machineImages.set(slug, readFileSync(new URL(filename, import.meta.url)));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    console.warn(`Machine image missing for ${slug}: ${filename}`);
  }
}

const insiderUsers = new Map();
for (const [uuid, profile] of Object.entries(config.insider_users ?? {})) {
  if (!insiderPattern.test(uuid) || insiderUsers.has(uuid.toLowerCase())
      || !profile || typeof profile !== 'object' || Array.isArray(profile)
      || ['username', 'display_name'].some(key =>
        profile[key] !== undefined && (typeof profile[key] !== 'string' || !profile[key].trim()))) {
    throw new Error(`Invalid Insider user configuration for "${uuid}"`);
  }
  insiderUsers.set(uuid.toLowerCase(), {
    username: profile.username?.trim(),
    displayName: profile.display_name?.trim(),
  });
}

const database = new DatabaseSync(resolve(dirname(configPath), config.database));
database.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = FULL;
  PRAGMA busy_timeout = 1000;

  CREATE TABLE IF NOT EXISTS games_played (
    id INTEGER PRIMARY KEY,
    slug TEXT NOT NULL,
    received_at_ms INTEGER NOT NULL,
    sender TEXT NOT NULL,
    payload TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS games_played_history ON games_played(slug, id DESC);
  CREATE INDEX IF NOT EXISTS games_played_retry ON games_played(slug, sender, received_at_ms);

  BEGIN IMMEDIATE;

  CREATE TABLE IF NOT EXISTS users (
    insider_uuid TEXT PRIMARY KEY NOT NULL,
    username TEXT
  );

  INSERT OR IGNORE INTO users (insider_uuid)
  SELECT DISTINCT lower(player.value)
  FROM games_played, json_each(games_played.payload, '$.insider') AS player
  WHERE player.type = 'text';

  CREATE TRIGGER IF NOT EXISTS remember_insider_users
  AFTER INSERT ON games_played
  BEGIN
    INSERT OR IGNORE INTO users (insider_uuid)
    SELECT lower(value) FROM json_each(NEW.payload, '$.insider') WHERE type = 'text';
  END;

  COMMIT;
`);

database.exec('BEGIN IMMEDIATE');
try {
  if (!database.prepare("PRAGMA table_info('users')").all().some(column => column.name === 'display_name')) {
    database.exec('ALTER TABLE users ADD COLUMN display_name TEXT');
    const importName = database.prepare(`
      INSERT INTO users (insider_uuid, username, display_name) VALUES (?, ?, ?)
      ON CONFLICT (insider_uuid) DO UPDATE SET
        username = coalesce(excluded.username, users.username),
        display_name = excluded.display_name
    `);
    for (const [uuid, profile] of insiderUsers) {
      importName.run(uuid, profile.username ?? null, profile.displayName ?? null);
    }
  }
  database.exec('COMMIT');
} catch (error) {
  database.exec('ROLLBACK');
  throw error;
}

const findUser = database.prepare('SELECT username, display_name FROM users WHERE insider_uuid = ?');
const listUsers = database.prepare(`
  SELECT insider_uuid, username, display_name FROM users
  ORDER BY (username IS NOT NULL OR display_name IS NOT NULL),
           coalesce(display_name, username, insider_uuid) COLLATE NOCASE, insider_uuid
`);
const updateUser = database.prepare('UPDATE users SET username = ?, display_name = ? WHERE insider_uuid = ?');

function resolvePlayer(insiderId) {
  if (insiderId === null) return null;
  const uuid = insiderId.toLowerCase();
  const user = findUser.get(uuid);
  const username = user?.username ?? null;
  const displayName = user?.display_name ?? username;
  return { insider_uuid: uuid, username, display_name: displayName };
}

const saveGame = database.prepare(`
  INSERT INTO games_played (slug, received_at_ms, sender, payload)
  SELECT ?, ?, ?, ?
  WHERE NOT EXISTS (
    SELECT 1 FROM games_played
    WHERE slug = ? AND sender = ? AND received_at_ms >= ? AND payload = ?
  )
`);
const history = database.prepare(`
  SELECT id, received_at_ms, payload FROM games_played
  WHERE slug = ? AND id < ?
  ORDER BY id DESC LIMIT ?
`);
const recent = database.prepare(`
  SELECT id, slug, received_at_ms, payload FROM games_played
  WHERE slug IN (SELECT value FROM json_each(?))
  ORDER BY id DESC LIMIT ?
`);
const configuredSlugs = JSON.stringify([...games.keys()]);
const historyPageSize = 20;
const maxBodyBytes = 16 * 1024;
const retryWindowMs = 30_000;

function parsePayload(body) {
  let game;
  try {
    // Preserve exact integers during validation, even above Number.MAX_SAFE_INTEGER.
    game = JSON.parse(body, (_key, value, context) => {
      if (typeof value === 'number' && /^-?\d+$/.test(context.source)) {
        return BigInt(context.source);
      }
      return value;
    });
  } catch {
    return null;
  }

  const valid = game?.source === 'PAD score feed'
    && typeof game.game === 'string' && game.game.length > 0
    && typeof game.port === 'string' && game.port.length > 0
    && typeof game.game_number === 'bigint' && game.game_number >= 1n
    && (game.time === null || typeof game.time === 'bigint')
    && typeof game.players === 'bigint' && game.players >= 1n && game.players <= 4n
    && Array.isArray(game.scores) && game.scores.length === Number(game.players)
    && game.scores.every(score => typeof score === 'bigint' && score >= 0n)
    && Array.isArray(game.insider) && game.insider.length === Number(game.players)
    && game.insider.every(id => id === null || (typeof id === 'string' && insiderPattern.test(id)));
  return valid ? game : null;
}

function json(response, status, data) {
  const body = JSON.stringify(data);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

function readEvent(row) {
  // Preserve the exact numeric tokens PAD sent, even for very large scores.
  const payload = JSON.parse(row.payload, (_key, value, context) =>
    typeof value === 'number' ? JSON.rawJSON(context.source) : value);
  return {
    id: row.id,
    received_at: new Date(row.received_at_ms).toISOString(),
    payload,
    insider_users: payload.insider.map(resolvePlayer),
  };
}

function html(response, body) {
  return response.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'",
  }).end(body);
}

async function readJsonBody(request, response) {
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    json(response, 415, { error: 'Expected application/json' });
    return null;
  }
  const chunks = [];
  let size = 0;
  // Leaving the iterator early keeps the connection available to send a 413.
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      response.setHeader('Connection', 'close');
      request.resume();
      json(response, 413, { error: 'JSON payload exceeds 16 KiB' });
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function handle(request, response) {
  const url = new URL(request.url, 'http://localhost');
  if (request.method === 'GET') {
    if (url.pathname === '/') {
      const events = recent.all(configuredSlugs, 8).map(row => ({ ...readEvent(row), slug: row.slug }));
      return html(response, renderHome(games, events, machineImages));
    }
    if (url.pathname === '/score-pages.css') {
      return response.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-cache' }).end(scoreStyles);
    }
    const imageSlug = /^\/machine-images\/([a-z0-9-]+)\.png$/.exec(url.pathname)?.[1];
    const image = machineImages.get(imageSlug);
    if (image) {
      return response.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': image.length,
        'Cache-Control': 'no-cache',
      }).end(image);
    }
    const machineSlug = /^\/machines\/([^/]+)$/.exec(url.pathname)?.[1];
    if (games.has(machineSlug)) {
      const before = Number(url.searchParams.get('before') ?? Number.MAX_SAFE_INTEGER);
      if (!Number.isSafeInteger(before) || before < 1) {
        return json(response, 400, { error: 'Use a positive integer before cursor' });
      }
      const rows = history.all(machineSlug, before, historyPageSize + 1);
      return html(response, renderMachine({
        slug: machineSlug,
        name: games.get(machineSlug),
        hasImage: machineImages.has(machineSlug),
        events: rows.slice(0, historyPageSize).map(readEvent),
        hasOlder: rows.length > historyPageSize,
        isLatest: !url.searchParams.has('before'),
      }));
    }
  }
  if (request.method === 'GET' && url.pathname === '/users') {
    return response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': usersPage.length,
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
    }).end(usersPage);
  }
  if (request.method === 'GET' && url.pathname === '/api/users') {
    return json(response, 200, listUsers.all());
  }
  const userId = /^\/api\/users\/([^/]+)$/.exec(url.pathname)?.[1];
  if (request.method === 'PUT' && userId) {
    if (!insiderPattern.test(userId)) {
      return json(response, 400, { error: 'Invalid Insider UUID' });
    }
    const body = await readJsonBody(request, response);
    if (body === null) return;
    let names;
    try {
      names = JSON.parse(body);
    } catch {
      return json(response, 400, { error: 'Invalid JSON' });
    }
    const validName = name => typeof name === 'string' && name.length <= 100;
    if (!validName(names?.username) || !validName(names?.display_name)) {
      return json(response, 400, { error: 'Enter names of 100 characters or fewer.' });
    }
    const { changes } = updateUser.run(names.username.trim() || null, names.display_name.trim() || null, userId.toLowerCase());
    if (!changes) return json(response, 404, { error: 'Insider user not found' });
    return response.writeHead(204).end();
  }
  if (request.method === 'GET' && url.pathname === '/scores') {
    return json(response, 200, [...games].map(([slug, name]) => ({
      slug, name, path: `/scores/${slug}`,
    })));
  }

  const slug = /^\/scores\/([^/]+)$/.exec(url.pathname)?.[1];
  if (!games.has(slug)) {
    return json(response, 404, { error: 'Unknown score route' });
  }

  if (request.method === 'GET') {
    const limit = Number(url.searchParams.get('limit') ?? 50);
    const before = Number(url.searchParams.get('before') ?? Number.MAX_SAFE_INTEGER);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500
        || !Number.isSafeInteger(before) || before < 1) {
      return json(response, 400, { error: 'Use limit 1–500 and a positive integer before cursor' });
    }
    const rows = history.all(slug, before, limit + 1);
    const events = rows.slice(0, limit).map(readEvent);
    return json(response, 200, {
      slug, name: games.get(slug), events,
      next_before: rows.length > limit ? events.at(-1).id : null,
    });
  }

  if (request.method !== 'POST') {
    response.setHeader('Allow', 'GET, POST');
    return json(response, 405, { error: 'Use GET or POST' });
  }
  const body = await readJsonBody(request, response);
  if (body === null) return;
  const game = parsePayload(body);
  if (!game) {
    return json(response, 400, { error: 'Invalid PAD score payload' });
  }

  const now = Date.now();
  const sender = request.socket.remoteAddress;
  const { changes } = saveGame.run(slug, now, sender, body, slug, sender, now - retryWindowMs, body);
  if (changes > 0) {
    console.log(`${new Date(now).toISOString()} SCORE ${JSON.stringify(games.get(slug))} (${slug}) from ${sender} game #${game.game_number} scores [${game.scores.join(', ')}]`);
  }
  response.writeHead(204).end();
}

const server = createServer((request, response) => {
  const started = performance.now();
  const client = request.socket.remoteAddress;
  response.once('close', () => {
    const status = response.writableFinished ? response.statusCode : 'aborted';
    const elapsedMs = (performance.now() - started).toFixed(1);
    console.log(`${new Date().toISOString()} ACCESS ${client} ${request.method} ${JSON.stringify(request.url)} ${status} ${elapsedMs} ms`);
  });

  handle(request, response).catch(error => {
    console.error(error);
    if (!response.headersSent && !response.destroyed) {
      json(response, 500, { error: 'Could not process score request' });
    }
  });
});

server.listen(config.port, config.host, () => {
  console.log(`PAD score receiver listening on ${config.host}:${server.address().port}`);
});
