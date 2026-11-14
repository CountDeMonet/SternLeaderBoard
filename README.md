# SternLeaderBoard
Using PAD end of game score pushes, creates a local leaderboard for display on tv's

## Home arcade

Run `node server.mjs` with Node.js 24 and open `http://localhost:8080/` or
the receiver's LAN address. The home page links to each configured machine and
the Users tool. Each machine page at `/machines/<slug>` shows its latest game
and a paginated history. Reload to see newly received scores. Times are Eastern.

To add artwork for a machine, put its PNG next to `server.mjs`, add a
`machine_images` entry in `config.json` mapping its slug to the filename, and
restart. Copy the PNGs with the project when moving the receiver.

PAD still posts to `/scores/<slug>`, which also serves the JSON history.
When moving the receiver, copy `server.mjs`, `score-pages.mjs`, `score-pages.css`,
`users.html`, `config.json`, and the SQLite database.
