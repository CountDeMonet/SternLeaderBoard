const htmlEntities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escape = value => String(value).replace(/[&<>"']/g, char => htmlEntities[char]);
const numberFormat = new Intl.NumberFormat('en-US');
const dates = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC',
});
const gameTypeLabels = new Map([
  ['standard', 'Standard'],
  ['challenge', 'Challenge'],
  ['competition', 'Competition'],
  ['tournament', 'Tournament'],
  ['head_to_head', 'Head-to-head'],
  ['team', 'Team'],
  ['cooperation', 'Cooperation'],
]);

function modeLabel(gameType, challenge) {
  if (gameType === 'challenge' && typeof challenge === 'string' && challenge.trim()) {
    return `Challenge · ${challenge.trim()}`;
  }
  return gameTypeLabels.get(gameType) ?? 'Unknown game type';
}

function page(title, current, body) {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} · Stern LeaderBoard</title>
<link rel="stylesheet" href="/score-pages.css">
<script src="/score-times.js" defer></script>
<body>
<header class="bar">
  <div class="shell masthead">
    <a class="brand" href="/"><span class="ball" aria-hidden="true"></span> Stern LeaderBoard</a>
    <nav aria-label="Main">
      <a href="/"${current === 'home' ? ' aria-current="page"' : ''}>Home</a>
      <a href="/users">Manage users</a>
    </nav>
  </div>
</header>
<main class="shell">${body}</main>
</body>
</html>`;
}

function scoreCard(event, title) {
  const date = dates.format(new Date(event.received_at));
  const mode = escape(modeLabel(event.payload.game_type, event.payload.challenge));
  const names = event.insider_users;
  const scores = event.payload.scores.map((score, index) => `
    <li>
      <span><span class="position" aria-label="Player ${index + 1}">P${index + 1}</span>
      ${escape(names[index]?.display_name ?? `Player ${index + 1}`)}</span>
      <strong>${numberFormat.format(BigInt(score.rawJSON))}</strong>
    </li>`).join('');
  return `<article class="score">
    <header><h3>${title ?? mode}</h3>${title ? `<span class="mode">${mode}</span>` : ''}
      <time datetime="${event.received_at}">${date} UTC</time></header>
    <ol>${scores}</ol>
  </article>`;
}

export function renderHome(games, events, machineImages) {
  const [latest, ...previous] = events;
  const machineLink = slug => `<a href="/machines/${slug}">${escape(games.get(slug))}</a>`;
  const machines = [...games].map(([slug, name]) => `
    <li><a href="/machines/${slug}">
      ${machineImages.has(slug) ? `<img src="/machine-images/${slug}.png" alt="" decoding="async">` : ''}
      <span class="machine-name">${escape(name)} <span aria-hidden="true">↗</span></span>
    </a></li>`).join('');
  return page('Home', 'home', `
    <div class="intro"><h1>Home arcade</h1><p>Recent scores and game history from your pinball machines.</p></div>
    <section class="section"><h2>Machines</h2>
      ${machines ? `<ul class="machines">${machines}</ul>` : '<p class="empty">No machines configured.</p>'}
    </section>
    <section class="section latest"><h2>Latest game</h2>
      ${latest ? scoreCard(latest, machineLink(latest.slug)) : '<p class="empty">Waiting for the first game.</p>'}
    </section>
    ${previous.length ? `<section class="section"><h2>Recent games</h2>
      <div class="cards">${previous.map(event => scoreCard(event, machineLink(event.slug))).join('')}</div>
    </section>` : ''}
  `);
}

export function renderMachine({ slug, name, hasImage, groups, events, hasOlder, isLatest }) {
  const latest = isLatest ? events[0] : null;
  const earlier = isLatest ? events.slice(1) : events;
  return page(name, 'machine', `
    <div class="intro"><a class="back" href="/">← All machines</a><h1>${escape(name)}</h1></div>
    <div class="machine-feature">
      ${hasImage ? `<img class="machine-art" src="/machine-images/${slug}.png" alt="" decoding="async">` : ''}
      ${isLatest ? `<section class="section latest"><h2>Latest game</h2>
        ${latest ? scoreCard(latest) : '<p class="empty">Waiting for the first game.</p>'}
      </section>` : ''}
    </div>
    ${isLatest ? `<section class="section"><h2>High scores by game type</h2>
      ${groups.length ? `<div class="cards">${groups.map(group => `
        <article class="score">
          <h3>${escape(modeLabel(group.game_type, group.challenge))}</h3>
          <ol>${group.scores.map(entry => `
            <li><span><span class="position">${entry.rank}.</span>
              ${escape(entry.insider_user?.display_name ?? `Player ${entry.player}`)}</span>
              <strong>${numberFormat.format(BigInt(entry.score.rawJSON))}</strong></li>`).join('')}
          </ol>
        </article>`).join('')}</div>` : '<p class="empty">High scores will appear after the first game.</p>'}
    </section>` : ''}
    <section class="section"><h2>Game history</h2>
      ${earlier.length ? `<div class="cards">${earlier.map(event => scoreCard(event)).join('')}</div>`
        : `<p class="empty">${latest ? 'Earlier games will appear here.' : 'No games on this page.'}</p>`}
      ${!isLatest || hasOlder ? `<nav class="pager" aria-label="Game history">
        ${isLatest ? '' : `<a href="/machines/${slug}">Newest games</a>`}
        ${hasOlder ? `<a href="/machines/${slug}?before=${events.at(-1).id}">Older games →</a>` : ''}
      </nav>` : ''}
    </section>
  `);
}
