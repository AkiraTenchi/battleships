// Battleships — two-player online game server.
// Zero dependencies: plain Node http, JSON endpoints and Server-Sent Events.
// The server is authoritative: each player only ever receives their own fleet
// and the results of shots, so nobody can peek at the opponent's ships.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const SIZE = 10;
const FLEET = [
  { id: 'carrier', name: 'Carrier', len: 5 },
  { id: 'battleship', name: 'Battleship', len: 4 },
  { id: 'cruiser', name: 'Cruiser', len: 3 },
  { id: 'submarine', name: 'Submarine', len: 3 },
  { id: 'destroyer', name: 'Destroyer', len: 2 },
  { id: 'patrol', name: 'Patrol boat', len: 2 },
  { id: 'skiff1', name: 'Skiff', len: 1 },
  { id: 'skiff2', name: 'Skiff', len: 1 },
  { id: 'skiff3', name: 'Skiff', len: 1 },
];
const ROOM_IDLE_MS = 30 * 60 * 1000;

const rooms = new Map();

// ---------- room & player helpers ----------

function newCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from(crypto.randomBytes(5), (b) => alphabet[b % alphabet.length]).join('');
  } while (rooms.has(code));
  return code;
}

function newPlayer(name) {
  return {
    token: crypto.randomBytes(16).toString('hex'),
    name: cleanName(name),
    ships: null, // [{ id, name, len, dir, cells: [[x,y]], hits: Set<"x,y"> }]
    shots: new Map(), // squares this player knows: "x,y" -> 'hit' | 'miss' | 'auto' (water next to a sunk ship)
    ready: false,
    rematch: false,
    clients: new Set(),
  };
}

function cleanName(name) {
  const s = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 20);
  return s || null;
}

function findPlayer(room, token) {
  if (!room || typeof token !== 'string') return -1;
  return room.players.findIndex((p) => p && p.token === token);
}

function resetForNewRound(room) {
  for (const p of room.players) {
    p.ships = null;
    p.shots = new Map();
    p.ready = false;
    p.rematch = false;
  }
  room.starter = 1 - room.starter;
  room.turn = room.starter;
  room.phase = 'placing';
  room.winner = null;
  room.log = [];
}

// ---------- rules ----------

function shipCells(len, x, y, dir) {
  const cells = [];
  for (let i = 0; i < len; i++) cells.push(dir === 'h' ? [x + i, y] : [x, y + i]);
  return cells;
}

// The up-to-8 squares around a cell that are on the board.
function neighbours(x, y) {
  const out = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx;
      const ny = y + dy;
      if ((dx || dy) && nx >= 0 && ny >= 0 && nx < SIZE && ny < SIZE) out.push([nx, ny]);
    }
  }
  return out;
}

function validateFleet(input) {
  if (!Array.isArray(input) || input.length !== FLEET.length) return null;
  const occupied = new Map(); // "x,y" -> ship id
  const ships = [];
  for (const spec of FLEET) {
    const s = input.find((p) => p && p.id === spec.id);
    if (!s || (s.dir !== 'h' && s.dir !== 'v')) return null;
    if (!Number.isInteger(s.x) || !Number.isInteger(s.y)) return null;
    const cells = shipCells(spec.len, s.x, s.y, s.dir);
    for (const [cx, cy] of cells) {
      if (cx < 0 || cy < 0 || cx >= SIZE || cy >= SIZE) return null;
      const key = cx + ',' + cy;
      if (occupied.has(key)) return null;
      occupied.set(key, spec.id);
    }
    ships.push({ ...spec, dir: s.dir, cells, hits: new Set() });
  }
  // Ships may not touch, not even diagonally.
  for (const ship of ships) {
    for (const [x, y] of ship.cells) {
      for (const [nx, ny] of neighbours(x, y)) {
        const other = occupied.get(nx + ',' + ny);
        if (other && other !== ship.id) return null;
      }
    }
  }
  return ships;
}

const isSunk = (ship) => ship.hits.size === ship.len;

function fire(room, shooter, x, y) {
  const target = room.players[1 - shooter];
  const key = x + ',' + y;
  const me = room.players[shooter];
  const ship = target.ships.find((s) => s.cells.some(([cx, cy]) => cx === x && cy === y));
  let result = 'miss';
  let sunk = null;
  if (ship) {
    ship.hits.add(key);
    result = 'hit';
    if (isSunk(ship)) sunk = ship.id;
  }
  me.shots.set(key, result);
  if (sunk) {
    // Ships can't touch, so the water around a sunk ship is known: mark it.
    for (const [cx, cy] of ship.cells) {
      for (const [nx, ny] of neighbours(cx, cy)) {
        const k = nx + ',' + ny;
        if (!me.shots.has(k)) me.shots.set(k, 'auto');
      }
    }
  }
  room.log.push({ by: shooter, x, y, result, sunk });
  if (target.ships.every(isSunk)) {
    room.phase = 'over';
    room.winner = shooter;
  } else if (result === 'miss') {
    room.turn = 1 - shooter; // a hit earns another shot
  }
}

// ---------- per-player view ----------

function publicShip(s) {
  return { id: s.id, name: s.name, len: s.len, dir: s.dir, cells: s.cells, sunk: isSunk(s) };
}

function viewFor(room, i) {
  const me = room.players[i];
  const opp = room.players[1 - i];
  const shotList = (p) => (p ? [...p.shots].map(([k, result]) => {
    const [x, y] = k.split(',').map(Number);
    return { x, y, result };
  }) : []);
  const reveal = room.phase === 'over';
  return {
    code: room.code,
    phase: room.phase,
    you: i,
    size: SIZE,
    fleet: FLEET,
    names: [me.name, opp ? opp.name : null],
    turn: room.turn === i ? 'you' : 'opponent',
    winner: room.winner === null ? null : room.winner === i ? 'you' : 'opponent',
    youReady: me.ready,
    opponentJoined: !!opp,
    opponentReady: !!(opp && opp.ready),
    opponentOnline: !!(opp && opp.clients.size),
    rematch: { you: me.rematch, opponent: !!(opp && opp.rematch) },
    yourShips: me.ships ? me.ships.map(publicShip) : null,
    incoming: shotList(opp), // shots the opponent fired at you
    outgoing: shotList(me), // shots you fired at the opponent
    enemyShips: opp && opp.ships
      ? opp.ships.filter((s) => reveal || isSunk(s)).map(publicShip)
      : [],
    log: room.log.slice(-40).map((e) => ({ ...e, by: e.by === i ? 'you' : 'opponent' })),
  };
}

function broadcast(room) {
  room.lastActive = Date.now();
  room.players.forEach((p, i) => {
    if (!p) return;
    const data = `data: ${JSON.stringify(viewFor(room, i))}\n\n`;
    for (const res of p.clients) res.write(data);
  });
}

// ---------- HTTP plumbing ----------

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 10_000) {
        reject(new Error('Body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 403, { error: 'Forbidden' });
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

// Each action receives (room, playerIndex, body) and returns an error string or nothing.
const actions = {
  place(room, i, body) {
    if (room.phase !== 'placing') return 'Ships can only be placed before the battle.';
    const ships = validateFleet(body.ships);
    if (!ships) return 'Invalid fleet placement.';
    room.players[i].ships = ships;
    room.players[i].ready = true;
    if (room.players.every((p) => p && p.ready)) room.phase = 'battle';
  },
  unready(room, i) {
    if (room.phase !== 'placing') return 'The battle has already started.';
    room.players[i].ready = false;
  },
  fire(room, i, body) {
    if (room.phase !== 'battle') return 'The battle is not in progress.';
    if (room.turn !== i) return "It's not your turn.";
    const { x, y } = body;
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= SIZE || y >= SIZE) {
      return 'Shot is off the board.';
    }
    if (room.players[i].shots.has(x + ',' + y)) return 'You already fired there.';
    fire(room, i, x, y);
  },
  rematch(room, i) {
    if (room.phase !== 'over') return 'The game is not over yet.';
    room.players[i].rematch = true;
    if (room.players.every((p) => p.rematch)) resetForNewRound(room);
  },
};

async function handleApi(req, res, url) {
  const route = url.pathname.slice('/api/'.length);

  if (req.method === 'GET' && route === 'events') {
    const room = rooms.get(String(url.searchParams.get('room') || '').toUpperCase());
    const i = findPlayer(room, url.searchParams.get('token'));
    if (i < 0) return sendJson(res, 404, { error: 'Game not found.' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    res.write('retry: 2000\n\n');
    const player = room.players[i];
    player.clients.add(res);
    broadcast(room); // tells the opponent we're online, and sends us the state
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(ping);
      player.clients.delete(res);
      broadcast(room);
    });
    return;
  }

  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });

  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return sendJson(res, 400, { error: e.message });
  }

  if (route === 'create') {
    const code = newCode();
    const host = newPlayer(body.name);
    rooms.set(code, {
      code,
      players: [host, null],
      phase: 'placing',
      turn: 0,
      starter: 0,
      winner: null,
      log: [],
      lastActive: Date.now(),
    });
    return sendJson(res, 200, { room: code, token: host.token });
  }

  const room = rooms.get(String(body.room || '').toUpperCase());
  if (!room) return sendJson(res, 404, { error: 'No game with that code.' });

  if (route === 'join') {
    if (room.players[1]) return sendJson(res, 409, { error: 'That game already has two players.' });
    const guest = newPlayer(body.name);
    room.players[1] = guest;
    broadcast(room);
    return sendJson(res, 200, { room: room.code, token: guest.token });
  }

  const action = actions[route];
  if (!action) return sendJson(res, 404, { error: 'Unknown action.' });
  const i = findPlayer(room, body.token);
  if (i < 0) return sendJson(res, 403, { error: 'You are not in this game.' });
  const error = action(room, i, body);
  if (error) return sendJson(res, 409, { error });
  broadcast(room);
  sendJson(res, 200, { ok: true });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((err) => {
      console.error(err);
      if (!res.headersSent) sendJson(res, 500, { error: 'Server error' });
    });
  } else if (req.method === 'GET') {
    serveStatic(req, res, url.pathname);
  } else {
    sendJson(res, 405, { error: 'Method not allowed' });
  }
});

// Forget rooms nobody has touched in a while.
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const online = room.players.some((p) => p && p.clients.size);
    if (!online && now - room.lastActive > ROOM_IDLE_MS) rooms.delete(code);
  }
}, 60_000).unref();

server.listen(PORT, () => {
  console.log(`Battleships running at http://localhost:${PORT}`);
});
