// Battleships — browser client.
// Talks to server.js: POST /api/* for actions, an EventSource for live state.

(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const LETTERS = 'ABCDEFGHIJ';
  const SIZE = 10;
  const coord = (x, y) => LETTERS[y] + (x + 1);
  const key = (x, y) => x + ',' + y;

  let session = null; // { room, token }
  let view = null; // latest state from the server
  let events = null;
  let prevPhase = null;

  // Local, not-yet-submitted fleet layout.
  const placement = { ships: {}, selected: null, dir: 'h', hover: null };

  // ---------- small utilities ----------

  let toastTimer;
  function toast(msg, isError = false) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.toggle('error', isError);
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
  }

  async function api(route, body = {}) {
    const res = await fetch('/api/' + route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, ...(session || {}) }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || 'Something went wrong.');
      err.status = res.status;
      throw err;
    }
    return data;
  }

  const storage = {
    get(store, k) { try { return window[store].getItem(k); } catch { return null; } },
    set(store, k, v) { try { window[store].setItem(k, v); } catch { /* storage unavailable */ } },
    del(store, k) { try { window[store].removeItem(k); } catch { /* storage unavailable */ } },
  };
  const tokenKey = (room) => 'battleships:' + room;

  function remember(room, token) {
    // sessionStorage keeps two tabs in one browser as separate players;
    // localStorage lets you rejoin after closing the tab.
    storage.set('sessionStorage', tokenKey(room), token);
    storage.set('localStorage', tokenKey(room), token);
    const name = $('#name').value.trim();
    if (name) storage.set('localStorage', 'battleships:name', name);
  }

  function opponentName() {
    return (view && view.names[1]) || 'Opponent';
  }

  // ---------- lobby ----------

  async function createGame() {
    try {
      const { room, token } = await api('create', { name: $('#name').value });
      startSession(room, token);
    } catch (e) {
      toast(e.message, true);
    }
  }

  async function joinGame(code) {
    code = code.trim().toUpperCase();
    if (!code) return toast('Enter a game code.', true);
    try {
      const { room, token } = await api('join', { room: code, name: $('#name').value });
      startSession(room, token);
    } catch (e) {
      const saved = storage.get('localStorage', tokenKey(code));
      if (e.status === 409 && saved) return startSession(code, saved); // rejoin our old seat
      toast(e.message, true);
    }
  }

  function startSession(room, token) {
    session = { room, token };
    remember(room, token);
    const url = new URL(location.href);
    url.search = '?room=' + room;
    history.replaceState(null, '', url);
    connect();
  }

  function leaveToLobby(message) {
    if (events) events.close();
    events = null;
    if (session) {
      storage.del('sessionStorage', tokenKey(session.room));
      storage.del('localStorage', tokenKey(session.room));
    }
    session = null;
    view = null;
    history.replaceState(null, '', location.pathname);
    $('#screen-game').hidden = true;
    $('#screen-lobby').hidden = false;
    $('#room-badge').hidden = true;
    $('#conn').hidden = true;
    if (message) toast(message, true);
  }

  // ---------- live connection ----------

  function connect() {
    if (events) events.close();
    const q = new URLSearchParams(session);
    events = new EventSource('/api/events?' + q);
    let gotData = false;
    events.onmessage = (e) => {
      gotData = true;
      $('#conn').hidden = true;
      view = JSON.parse(e.data);
      render();
    };
    events.onerror = () => {
      if (events.readyState === EventSource.CLOSED) {
        // Server rejected us (unknown room/token) or went away for good.
        if (!gotData) leaveToLobby('That game no longer exists.');
        else showConn('Disconnected — reload to retry');
      } else {
        showConn('Reconnecting…');
      }
    };
  }

  function showConn(text) {
    const el = $('#conn');
    el.textContent = text;
    el.hidden = false;
  }

  // ---------- boards ----------

  function buildBoard(el) {
    const parts = ['<div class="label corner"></div>'];
    for (let x = 0; x < SIZE; x++) parts.push(`<div class="label col">${x + 1}</div>`);
    for (let y = 0; y < SIZE; y++) {
      parts.push(`<div class="label">${LETTERS[y]}</div>`);
      for (let x = 0; x < SIZE; x++) {
        parts.push(`<button type="button" class="cell" data-x="${x}" data-y="${y}" aria-label="${coord(x, y)}"></button>`);
      }
    }
    el.innerHTML = parts.join('');
    el.cells = [...el.querySelectorAll('.cell')];
  }

  // classes: Map "x,y" -> Set of class names
  function paintBoard(el, classes) {
    for (const cell of el.cells) {
      const set = classes.get(key(+cell.dataset.x, +cell.dataset.y));
      cell.className = 'cell' + (set ? ' ' + [...set].join(' ') : '');
    }
  }

  function addClass(map, x, y, ...names) {
    const k = key(x, y);
    if (!map.has(k)) map.set(k, new Set());
    for (const n of names) map.get(k).add(n);
  }

  function addShip(map, cells, dir, ...extra) {
    cells.forEach(([x, y], i) => {
      const end = cells.length === 1 ? ['solo'] : i === 0 ? ['bow'] : i === cells.length - 1 ? ['stern'] : [];
      addClass(map, x, y, 'ship', 'seg-' + dir, ...end, ...extra);
    });
  }

  function shipCells(len, x, y, dir) {
    const cells = [];
    for (let i = 0; i < len; i++) cells.push(dir === 'h' ? [x + i, y] : [x, y + i]);
    return cells;
  }

  // ---------- placement ----------

  function fleetSpec(id) {
    return view.fleet.find((s) => s.id === id);
  }

  function occupiedBy(exceptId) {
    const taken = new Map();
    for (const [id, p] of Object.entries(placement.ships)) {
      if (id === exceptId) continue;
      for (const [x, y] of shipCells(fleetSpec(id).len, p.x, p.y, p.dir)) taken.set(key(x, y), id);
    }
    return taken;
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

  // In bounds, not overlapping and not touching another ship (diagonals included).
  function fits(id, x, y, dir) {
    const taken = occupiedBy(id);
    return shipCells(fleetSpec(id).len, x, y, dir).every(
      ([cx, cy]) => cx >= 0 && cy >= 0 && cx < SIZE && cy < SIZE && !taken.has(key(cx, cy))
        && neighbours(cx, cy).every(([nx, ny]) => !taken.has(key(nx, ny))),
    );
  }

  function selectNextUnplaced() {
    const next = view.fleet.find((s) => !placement.ships[s.id]);
    placement.selected = next ? next.id : null;
  }

  function onPlaceClick(x, y) {
    const hitShip = occupiedBy(null).get(key(x, y));
    if (hitShip) {
      // pick a placed ship back up
      placement.dir = placement.ships[hitShip].dir;
      delete placement.ships[hitShip];
      placement.selected = hitShip;
    } else if (placement.selected && fits(placement.selected, x, y, placement.dir)) {
      placement.ships[placement.selected] = { x, y, dir: placement.dir };
      selectNextUnplaced();
    } else if (placement.selected) {
      toast("That ship doesn't fit there — ships can't touch.", true);
      return;
    }
    render();
  }

  function rotate() {
    placement.dir = placement.dir === 'h' ? 'v' : 'h';
    render();
  }

  function randomize() {
    const order = [...view.fleet].sort((a, b) => b.len - a.len);
    // Biggest ships first; if the small ones get boxed in, start over.
    for (let attempt = 0; attempt < 200; attempt++) {
      placement.ships = {};
      for (const s of order) {
        for (let tries = 0; tries < 300; tries++) {
          const dir = Math.random() < 0.5 ? 'h' : 'v';
          const x = Math.floor(Math.random() * SIZE);
          const y = Math.floor(Math.random() * SIZE);
          if (fits(s.id, x, y, dir)) {
            placement.ships[s.id] = { x, y, dir };
            break;
          }
        }
      }
      if (Object.keys(placement.ships).length === view.fleet.length) break;
    }
    selectNextUnplaced();
    render();
  }

  async function submitFleet() {
    const ships = Object.entries(placement.ships).map(([id, p]) => ({ id, ...p }));
    try {
      await api('place', { ships });
    } catch (e) {
      toast(e.message, true);
    }
  }

  function renderPlacement() {
    const board = $('#board-own');
    const classes = new Map();
    const taken = occupiedBy(null);
    for (const [id, p] of Object.entries(placement.ships)) {
      const cells = shipCells(fleetSpec(id).len, p.x, p.y, p.dir);
      addShip(classes, cells, p.dir);
      // Shade the no-go zone around each placed ship.
      for (const [x, y] of cells) {
        for (const [nx, ny] of neighbours(x, y)) {
          if (!taken.has(key(nx, ny))) addClass(classes, nx, ny, 'buffer');
        }
      }
    }
    if (placement.selected && placement.hover) {
      const { x, y } = placement.hover;
      const ok = fits(placement.selected, x, y, placement.dir);
      for (const [cx, cy] of shipCells(fleetSpec(placement.selected).len, x, y, placement.dir)) {
        if (cx < SIZE && cy < SIZE) addClass(classes, cx, cy, ok ? 'preview-ok' : 'preview-bad');
      }
    }
    paintBoard(board, classes);
    board.className = 'board placing';

    $('#dock').innerHTML = view.fleet.map((s) => {
      const state = placement.ships[s.id] ? 'placed' : s.id === placement.selected ? 'selected' : '';
      return `<li><button type="button" data-ship="${s.id}" class="${state}">
        <span>${s.name}</span><span class="pips">${'<i></i>'.repeat(s.len)}</span></button></li>`;
    }).join('');
    $('#dir-label').textContent = placement.dir === 'h' ? '(horizontal)' : '(vertical)';
    $('#btn-ready').disabled = Object.keys(placement.ships).length !== view.fleet.length;
  }

  // ---------- battle rendering ----------

  // 'auto' squares are water revealed around a sunk ship: drawn as a (fainter) miss.
  function addShot(classes, shot) {
    if (shot.result === 'auto') addClass(classes, shot.x, shot.y, 'miss', 'auto');
    else addClass(classes, shot.x, shot.y, shot.result);
  }

  function renderOwnBoard() {
    const classes = new Map();
    for (const s of view.yourShips || []) addShip(classes, s.cells, s.dir, ...(s.sunk ? ['sunk'] : []));
    for (const shot of view.incoming) addShot(classes, shot);
    const last = [...view.log].reverse().find((e) => e.by === 'opponent');
    if (last) addClass(classes, last.x, last.y, 'last');
    paintBoard($('#board-own'), classes);
    $('#board-own').className = 'board';
  }

  function renderEnemyBoard() {
    const classes = new Map();
    for (const s of view.enemyShips) addShip(classes, s.cells, s.dir, s.sunk ? 'sunk' : 'revealed');
    for (const shot of view.outgoing) addShot(classes, shot);
    const last = [...view.log].reverse().find((e) => e.by === 'you');
    if (last) addClass(classes, last.x, last.y, 'last');
    const board = $('#board-enemy');
    paintBoard(board, classes);
    const canFire = view.phase === 'battle' && view.turn === 'you';
    board.className = 'board' + (canFire ? ' targetable' : '');
  }

  function pips(len, hits) {
    let out = '';
    for (let i = 0; i < len; i++) out += i < hits ? '<i class="hit"></i>' : '<i></i>';
    return out;
  }

  function renderFleetStatus() {
    const incomingHits = new Set(view.incoming.filter((s) => s.result === 'hit').map((s) => key(s.x, s.y)));
    $('#own-status').innerHTML = (view.yourShips || []).map((s) => {
      const hits = s.cells.filter(([x, y]) => incomingHits.has(key(x, y))).length;
      return `<li class="${s.sunk ? 'sunk' : ''}">${s.name}<span class="pips">${pips(s.len, hits)}</span></li>`;
    }).join('');

    const sunkIds = new Set(view.enemyShips.filter((s) => s.sunk).map((s) => s.id));
    $('#enemy-status').innerHTML = view.fleet.map((s) => {
      const sunk = sunkIds.has(s.id);
      return `<li class="${sunk ? 'sunk' : ''}">${s.name}<span class="pips">${pips(s.len, sunk ? s.len : 0)}</span></li>`;
    }).join('');
  }

  function renderLog() {
    const names = Object.fromEntries(view.fleet.map((s) => [s.id, s.name]));
    const opp = opponentName();
    $('#log').innerHTML = [...view.log].reverse().map((e) => {
      const who = e.by === 'you' ? 'You' : opp;
      let text = `${who} fired at <span class="coord">${coord(e.x, e.y)}</span> — ${e.result === 'hit' ? 'hit!' : 'miss.'}`;
      if (e.sunk) {
        text += e.by === 'you'
          ? ` You sank their <b>${names[e.sunk]}</b>.`
          : ` Your <b>${names[e.sunk]}</b> was sunk.`;
      }
      const cls = [e.result, e.sunk ? 'sunk' : '', e.by === 'you' ? 'mine' : ''].join(' ');
      return `<li class="${cls}">${text}</li>`;
    }).join('');
    $('#log-wrap').hidden = view.log.length === 0;
  }

  function renderGameOver() {
    const shots = view.outgoing.filter((s) => s.result !== 'auto').length;
    const hits = view.outgoing.filter((s) => s.result === 'hit').length;
    const win = view.winner === 'you';
    $('#gameover-title').textContent = win
      ? `You sank ${opponentName()}'s entire fleet.`
      : `${opponentName()} sank your entire fleet.`;
    $('#stats').innerHTML = `
      <div><b>${shots}</b><span>Shots</span></div>
      <div><b>${hits}</b><span>Hits</span></div>
      <div><b>${shots ? Math.round((hits / shots) * 100) : 0}%</b><span>Accuracy</span></div>`;
    const btn = $('#btn-rematch');
    if (view.rematch.you) {
      btn.disabled = true;
      btn.textContent = `Waiting for ${opponentName()}…`;
    } else {
      btn.disabled = false;
      btn.textContent = view.rematch.opponent ? `${opponentName()} wants a rematch — accept` : 'Rematch';
    }
  }

  function setBanner(title, sub = '', cls = '') {
    $('#banner-title').textContent = title;
    $('#banner-sub').textContent = sub;
    $('#banner').className = 'banner ' + cls;
  }

  // ---------- main render ----------

  function render() {
    if (!view) return;
    $('#screen-lobby').hidden = true;
    $('#screen-game').hidden = false;

    const badge = $('#room-badge');
    badge.hidden = false;
    badge.innerHTML = `GAME <b>${view.code}</b>`;

    // New round (first load or after a rematch): start with an empty layout.
    if (view.phase === 'placing' && prevPhase !== 'placing') {
      placement.ships = {};
      placement.hover = null;
      if (view.yourShips) {
        for (const s of view.yourShips) placement.ships[s.id] = { x: s.cells[0][0], y: s.cells[0][1], dir: s.dir };
      }
      selectNextUnplaced();
    }
    prevPhase = view.phase;

    const invite = $('#invite');
    invite.hidden = view.opponentJoined;
    if (!view.opponentJoined) {
      $('#invite-code').textContent = view.code;
      $('#invite-url').value = location.origin + '/?room=' + view.code;
    }

    const opp = opponentName();
    const placing = view.phase === 'placing';
    const deploying = placing && !view.youReady;

    $('#panel-place').hidden = !deploying;
    $('#panel-waiting').hidden = !(placing && view.youReady);
    $('#panel-enemy').hidden = placing;
    $('#gameover').hidden = view.phase !== 'over';

    $('#own-tag').textContent = view.names[0] || '';
    const enemyTag = $('#enemy-tag');
    enemyTag.textContent = view.opponentOnline ? opp : `${opp} (offline)`;
    enemyTag.classList.toggle('offline', !view.opponentOnline);

    // Light up the board that matters this turn and fade the other one.
    const myTurn = view.phase === 'battle' && view.turn === 'you';
    const theirTurn = view.phase === 'battle' && view.turn === 'opponent';
    $('#panel-enemy').classList.toggle('active', myTurn);
    $('#panel-enemy').classList.toggle('dim', theirTurn);
    $('#panel-own').classList.toggle('incoming', theirTurn);
    $('#panel-own').classList.toggle('dim', myTurn);
    document.title = myTurn ? '● Your turn — Battleships' : 'Battleships';

    if (deploying) {
      setBanner('Deploy your fleet', view.opponentJoined
        ? (view.opponentReady ? `${opp} is ready and waiting for you.` : `${opp} is deploying too.`)
        : 'Your opponent can join at any time.');
      renderPlacement();
    } else {
      renderOwnBoard();
    }

    if (placing && view.youReady) {
      const text = !view.opponentJoined
        ? 'Waiting for an opponent to join…'
        : `Waiting for ${opp} to finish deploying…`;
      setBanner('Fleet ready', text);
      $('#waiting-text').textContent = text + ' You can still rearrange until the battle starts.';
    }

    if (!placing) {
      renderEnemyBoard();
      renderFleetStatus();
    } else {
      $('#own-status').innerHTML = '';
    }

    if (view.phase === 'battle') {
      const last = view.log[view.log.length - 1];
      const again = last && last.result === 'hit';
      if (view.turn === 'you') {
        setBanner(again ? 'Hit! Fire again' : 'Your turn',
          again ? 'A hit earns you another shot.' : `Pick a square in ${opp}'s waters to fire.`, 'your-turn');
      } else {
        setBanner(`${opp}'s turn`, again ? `${opp} scored a hit and fires again…` : 'Brace for incoming fire…', 'their-turn');
      }
    } else if (view.phase === 'over') {
      setBanner(view.winner === 'you' ? 'Victory!' : 'Defeat', '', view.winner === 'you' ? 'win' : 'lose');
      renderGameOver();
    }

    renderLog();
    notifyLatestShot();
  }

  // Short toast for the newest shot so players don't miss what happened.
  let seenLog = -1;
  function notifyLatestShot() {
    const n = view.log.length;
    if (seenLog === -1 || n < seenLog) { seenLog = n; return; } // first load / new round
    if (n === seenLog) return;
    seenLog = n;
    const e = view.log[n - 1];
    const names = Object.fromEntries(view.fleet.map((s) => [s.id, s.name]));
    const c = coord(e.x, e.y);
    if (e.by === 'you') {
      toast(e.sunk ? `${c}: Hit — you sank their ${names[e.sunk]}!` : `${c}: ${e.result === 'hit' ? 'Hit!' : 'Miss.'}`);
    } else {
      toast(e.sunk ? `${opponentName()} sank your ${names[e.sunk]} at ${c}.` : `${opponentName()} fired at ${c} — ${e.result}.`);
    }
  }

  // ---------- events ----------

  function setup() {
    buildBoard($('#board-own'));
    buildBoard($('#board-enemy'));

    $('#name').value = storage.get('localStorage', 'battleships:name') || '';
    $('#btn-create').addEventListener('click', createGame);
    $('#join-form').addEventListener('submit', (e) => {
      e.preventDefault();
      joinGame($('#join-code').value);
    });

    $('#btn-copy').addEventListener('click', async () => {
      const input = $('#invite-url');
      try {
        await navigator.clipboard.writeText(input.value);
      } catch {
        input.select();
        document.execCommand('copy');
      }
      toast('Invite link copied.');
    });

    const own = $('#board-own');
    own.addEventListener('click', (e) => {
      const cell = e.target.closest('.cell');
      if (!cell || !view || view.phase !== 'placing' || view.youReady) return;
      onPlaceClick(+cell.dataset.x, +cell.dataset.y);
    });
    own.addEventListener('pointerover', (e) => {
      const cell = e.target.closest('.cell');
      if (!cell || !view || view.phase !== 'placing' || view.youReady) return;
      placement.hover = { x: +cell.dataset.x, y: +cell.dataset.y };
      renderPlacement();
    });
    own.addEventListener('pointerleave', () => {
      if (!placement.hover) return;
      placement.hover = null;
      if (view && view.phase === 'placing' && !view.youReady) renderPlacement();
    });

    $('#board-enemy').addEventListener('click', async (e) => {
      const cell = e.target.closest('.cell');
      if (!cell || !view || view.phase !== 'battle') return;
      if (view.turn !== 'you') return toast(`Wait for ${opponentName()} to fire.`);
      const x = +cell.dataset.x;
      const y = +cell.dataset.y;
      const known = view.outgoing.find((s) => s.x === x && s.y === y);
      if (known) return toast(known.result === 'auto' ? "That's open water next to a sunk ship." : 'You already fired there.');
      try {
        await api('fire', { x, y });
      } catch (err) {
        toast(err.message, true);
      }
    });

    $('#dock').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-ship]');
      if (!btn) return;
      const id = btn.dataset.ship;
      if (placement.ships[id]) {
        placement.dir = placement.ships[id].dir;
        delete placement.ships[id];
      }
      placement.selected = id;
      render();
    });

    $('#btn-rotate').addEventListener('click', rotate);
    $('#btn-random').addEventListener('click', randomize);
    $('#btn-clear').addEventListener('click', () => {
      placement.ships = {};
      selectNextUnplaced();
      render();
    });
    $('#btn-ready').addEventListener('click', submitFleet);
    $('#btn-unready').addEventListener('click', () => api('unready').catch((e) => toast(e.message, true)));
    $('#btn-rematch').addEventListener('click', () => api('rematch').catch((e) => toast(e.message, true)));

    document.addEventListener('keydown', (e) => {
      if (e.target.matches('input')) return;
      if ((e.key === 'r' || e.key === 'R') && view && view.phase === 'placing' && !view.youReady) rotate();
    });

    // Arrived via a link or a reload?
    const code = (new URLSearchParams(location.search).get('room') || '').toUpperCase();
    if (code) {
      const saved = storage.get('sessionStorage', tokenKey(code));
      if (saved) {
        session = { room: code, token: saved };
        connect();
      } else {
        $('#join-code').value = code;
        $('#name').focus();
        $('#btn-create').classList.remove('primary');
        $('#join-form .btn').classList.add('primary');
      }
    }
  }

  setup();
})();
