const htmlEntities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escape = value => String(value).replace(/[&<>"']/g, char => htmlEntities[char]);
const numberFormat = new Intl.NumberFormat('en-US');
const dates = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/New_York',
});

function page(title, current, body) {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} · Stern LeaderBoard</title>
<link rel="stylesheet" href="/score-pages.css">
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
  const names = event.insider_users;
  const scores = event.payload.scores.map((score, index) => `
    <li>
      <span><span class="position" aria-label="Player ${index + 1}">P${index + 1}</span>
      ${escape(names[index]?.display_name ?? `Player ${index + 1}`)}</span>
      <strong>${numberFormat.format(BigInt(score.rawJSON))}</strong>
    </li>`).join('');
  return `<article class="score">
    <header><h3>${title}</h3><time datetime="${event.received_at}">${date} ET</time></header>
    <ol>${scores}</ol>
  </article>`;
}

export function renderHome(games, events) {
  const [latest, ...previous] = events;
  const machineLink = slug => `<a href="/machines/${slug}">${escape(games.get(slug))}</a>`;
  const machines = [...games].map(([slug, name]) => `
    <li><a href="/machines/${slug}"><span>${escape(name)}</span><span aria-hidden="true">↗</span></a></li>`).join('');
  return page('Home', 'home', `
    <div class="intro"><h1>Home arcade</h1><p>Recent scores and game history from your pinball machines.</p></div>
    <div class="overview">
      <section class="section latest"><h2>Latest game</h2>
        ${latest ? scoreCard(latest, machineLink(latest.slug)) : '<p class="empty">Waiting for the first game.</p>'}
      </section>
      <section class="section"><h2>Machines</h2>
        ${machines ? `<ul class="machines">${machines}</ul>` : '<p class="empty">No machines configured.</p>'}
      </section>
    </div>
    ${previous.length ? `<section class="section"><h2>Recent games</h2>
      <div class="cards">${previous.map(event => scoreCard(event, machineLink(event.slug))).join('')}</div>
    </section>` : ''}
  `);
}

export function renderMachine({ slug, name, events, hasOlder, isLatest }) {
  const latest = isLatest ? events[0] : null;
  const earlier = isLatest ? events.slice(1) : events;
  const gameTitle = event => `Game #${escape(event.payload.game_number.rawJSON)}`;
  return page(name, 'machine', `
    <div class="intro"><a class="back" href="/">← All machines</a><h1>${escape(name)}</h1></div>
    ${latest ? `<section class="section latest"><h2>Latest game</h2>${scoreCard(latest, gameTitle(latest))}</section>` : ''}
    <section class="section"><h2>Game history</h2>
      ${earlier.length ? `<div class="cards">${earlier.map(event => scoreCard(event, gameTitle(event))).join('')}</div>`
        : `<p class="empty">${latest ? 'Earlier games will appear here.' : 'No games on this page.'}</p>`}
      ${!isLatest || hasOlder ? `<nav class="pager" aria-label="Game history">
        ${isLatest ? '' : `<a href="/machines/${slug}">Newest games</a>`}
        ${hasOlder ? `<a href="/machines/${slug}?before=${events.at(-1).id}">Older games →</a>` : ''}
      </nav>` : ''}
    </section>
  `);
}
