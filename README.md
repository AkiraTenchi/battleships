# Battleships

Two-player online Battleships in the browser. No dependencies — just Node.js 18+.

```bash
npm start
```

Open http://localhost:3000, create a game and send the invite link (or the 5-letter code) to your opponent. To play on two devices, they need to reach your machine, e.g. `http://<your-LAN-IP>:3000` on the same network. Set `PORT` to change the port.

- 10×10 grid, fleet of Carrier (5), Battleship (4), Cruiser (3), Submarine (3), Destroyer (2), Patrol boat (2) and three Skiffs (1).
- Ships can't touch, not even diagonally. When a ship sinks, the squares around it are marked as water automatically.
- Players take turns firing; a hit earns another shot and a miss passes the turn. Sinking every ship wins. Rematches alternate who fires first.
- The server is authoritative and only sends each player their own ships, so nobody can peek.
- Reloading the page rejoins your seat. Games live in memory and are dropped after 30 idle minutes or a server restart.

Files: `server.js` (HTTP + Server-Sent Events game server), `public/` (client).
