export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>shuvbot history</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: #0b0d10; color: #eef0f2; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: radial-gradient(circle at 10% 0%, #253044 0, transparent 38%), #0b0d10; }
    header, main { width: min(1180px, calc(100% - 32px)); margin: 0 auto; }
    header { padding: 48px 0 28px; display: flex; align-items: end; justify-content: space-between; gap: 24px; }
    h1 { margin: 0; font: 700 clamp(2rem, 6vw, 4.5rem)/.9 ui-monospace, SFMono-Regular, monospace; letter-spacing: -.08em; }
    .eyebrow { color: #8ce6c1; font: 600 .75rem/1 ui-monospace, monospace; text-transform: uppercase; letter-spacing: .16em; margin-bottom: 14px; }
    .summary { color: #9ea6b2; max-width: 34rem; text-align: right; }
    form { display: grid; grid-template-columns: 2fr repeat(3, 1fr) auto; gap: 8px; padding: 12px; border: 1px solid #2b3038; background: #12161b; border-radius: 14px; position: sticky; top: 12px; z-index: 2; }
    input, select, button { min-width: 0; border: 1px solid #343a44; border-radius: 9px; background: #0d1014; color: inherit; padding: 10px 12px; font: inherit; }
    button { background: #8ce6c1; color: #07110d; border-color: #8ce6c1; font-weight: 700; cursor: pointer; }
    #runs { display: grid; gap: 10px; padding: 16px 0 48px; }
    article { display: grid; grid-template-columns: 10rem 1fr auto auto; gap: 20px; align-items: center; padding: 18px; border: 1px solid #282e36; border-radius: 14px; background: rgba(18, 22, 27, .88); }
    article:hover { border-color: #4b5664; transform: translateY(-1px); }
    time, .meta { color: #929ba7; font: .8rem/1.5 ui-monospace, monospace; }
    h2 { margin: 3px 0 7px; font-size: 1rem; }
    a { color: inherit; text-decoration: none; }
    .pill { display: inline-block; border: 1px solid #3b434e; border-radius: 999px; padding: 4px 8px; color: #c6cbd1; font-size: .72rem; }
    .success { color: #8ce6c1; } .failure { color: #ff8c82; } .running { color: #ffd479; }
    .count { font: 700 1.4rem/1 ui-monospace, monospace; text-align: right; }
    .inspect { background: transparent; color: #8ce6c1; border-color: #365e50; }
    .detail { grid-column: 1 / -1; display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; padding-top: 16px; border-top: 1px solid #282e36; }
    .detail section { min-width: 0; }
    .detail h3 { margin: 0 0 10px; color: #929ba7; font: 600 .72rem/1 ui-monospace, monospace; letter-spacing: .12em; text-transform: uppercase; }
    .detail ul { display: grid; gap: 8px; list-style: none; margin: 0; padding: 0; }
    .detail li { padding: 9px; border-radius: 8px; background: #0d1014; overflow-wrap: anywhere; }
    .empty { padding: 64px 16px; text-align: center; color: #929ba7; }
    @media (max-width: 760px) { header { align-items: start; flex-direction: column; } .summary { text-align: left; } form { grid-template-columns: 1fr 1fr; } form input:first-child { grid-column: 1 / -1; } article { grid-template-columns: 1fr auto; } article time { grid-column: 1 / -1; } .detail { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <header><div><div class="eyebrow">Central review ledger</div><h1>shuvbot<br>history</h1></div><p class="summary">Read-only history from validated GitHub Actions artifacts. Raw traces and rejected model payloads are never shown.</p></header>
  <main>
    <form id="filters">
      <input name="repository" aria-label="Repository" placeholder="owner/repository">
      <select name="status" aria-label="Status"><option value="">Any status</option><option>success</option><option>failure</option><option>running</option></select>
      <input name="command" aria-label="Command" placeholder="command">
      <select name="severity" aria-label="Severity"><option value="">Any severity</option><option>critical</option><option>high</option><option>medium</option><option>low</option><option>info</option></select>
      <select name="subject_kind" aria-label="Subject type"><option value="">Issue or PR</option><option value="pull_request">Pull request</option><option value="issue">Issue</option></select>
      <input name="subject_number" aria-label="Subject number" inputmode="numeric" placeholder="PR / issue #">
      <input name="from" aria-label="From date" type="date">
      <input name="to" aria-label="To date" type="date">
      <button type="submit">Filter</button>
    </form>
    <section id="runs" aria-live="polite"><div class="empty">Loading runs...</div></section>
  </main>
  <script>
    const form = document.querySelector('#filters');
    const runs = document.querySelector('#runs');
    const render = (items) => {
      runs.replaceChildren();
      if (!items.length) { const empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = 'No runs match these filters.'; runs.append(empty); return; }
      for (const item of items) {
        const card = document.createElement('article');
        const time = document.createElement('time'); time.dateTime = item.started_at; time.textContent = new Date(item.started_at).toLocaleString();
        const body = document.createElement('div');
        const meta = document.createElement('div'); meta.className = 'meta'; meta.textContent = item.repository + (item.subject_number ? ' · ' + item.subject_kind.replace('_', ' ') + ' #' + item.subject_number : '');
        const title = document.createElement('h2');
        const link = document.createElement('a'); link.href = item.html_url; link.rel = 'noreferrer'; link.textContent = item.command_name ? '@shuvbot ' + item.command_name : item.mode; title.append(link);
        const status = document.createElement('span'); status.className = 'pill ' + item.status; status.textContent = item.status + (item.review_decision ? ' · ' + item.review_decision : '');
        body.append(meta, title, status);
        const count = document.createElement('div'); count.className = 'count'; count.textContent = String(item.finding_count); count.title = 'findings';
        const inspect = document.createElement('button'); inspect.type = 'button'; inspect.className = 'inspect'; inspect.textContent = 'Inspect';
        inspect.addEventListener('click', async () => {
          inspect.disabled = true; inspect.textContent = 'Loading';
          try {
            const response = await fetch('/api/runs/' + item.id); const payload = await response.json();
            if (!response.ok) throw new Error(payload.error || 'Unable to load run');
            card.querySelector('.detail')?.remove(); card.append(renderDetail(payload.run)); inspect.textContent = 'Loaded';
          } catch (error) { inspect.disabled = false; inspect.textContent = 'Retry'; showError(error); }
        });
        card.append(time, body, count, inspect); runs.append(card);
      }
    };
    const renderDetail = (run) => {
      const detail = document.createElement('div'); detail.className = 'detail';
      const groups = [
        ['Findings', run.findings, (item) => item.severity + ' · ' + item.title + ' · ' + item.path + (item.line ? ':' + item.line : '')],
        ['Sessions', run.sessions, (item) => item.role + ' · ' + item.model + ' · ' + item.status + (item.input_tokens == null ? '' : ' · ' + item.input_tokens + ' in / ' + item.output_tokens + ' out')],
        ['Artifacts', run.artifacts, (item) => item.name + ' · ' + item.size_bytes.toLocaleString() + ' bytes' + (item.expires_at ? ' · expires ' + new Date(item.expires_at).toLocaleDateString() : '')]
      ];
      for (const [title, items, label] of groups) {
        const section = document.createElement('section'); const heading = document.createElement('h3'); heading.textContent = title;
        const list = document.createElement('ul');
        if (!items.length) { const row = document.createElement('li'); row.className = 'meta'; row.textContent = 'None recorded'; list.append(row); }
        for (const item of items) { const row = document.createElement('li'); row.textContent = label(item); list.append(row); }
        section.append(heading, list); detail.append(section);
      }
      return detail;
    };
    const load = async () => {
      runs.replaceChildren(Object.assign(document.createElement('div'), { className: 'empty', textContent: 'Loading runs...' }));
      const query = new URLSearchParams(new FormData(form));
      for (const [key, value] of [...query]) if (!value) query.delete(key);
      const response = await fetch('/api/runs?' + query);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Unable to load runs');
      render(payload.runs);
    };
    form.addEventListener('submit', (event) => { event.preventDefault(); load().catch(showError); });
    const showError = (error) => { runs.replaceChildren(Object.assign(document.createElement('div'), { className: 'empty', textContent: error.message })); };
    load().catch(showError);
  </script>
</body>
</html>`;
