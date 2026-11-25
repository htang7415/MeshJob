import { boards, referenceUrl } from './reference-boards.mjs';

const pending = Object.entries(boards).flatMap(([provider, names]) => names.map(board => ({ provider, board })));
const rows = [];
await Promise.all(Array.from({length: 4}, async () => {
  while (pending.length) {
    const { provider, board } = pending.shift();
    const start = Date.now();
    const url = referenceUrl(provider, board);
    const row = { provider, board, url, observedAt: new Date(start).toISOString() };
    try {
      const response = await fetch(url, {signal: AbortSignal.timeout(10000), redirect:'error'});
      row.status = response.status;
      if (response.ok) {
        const raw = await response.json();
        const jobs = Array.isArray(raw) ? raw : raw.jobs;
        row.count = jobs.length;
        row.ids = jobs.map(job => String(job.id ?? new URL(job.jobUrl).pathname.split('/').at(-1)));
        row.publicationDates = jobs.filter(job => Boolean(job.publishedAt)).length;
      }
    } catch (error) { row.error = String(error); }
    row.ms = Date.now() - start;
    rows.push(row);
  }
}));
console.log(JSON.stringify(rows.sort((a,b) => a.url.localeCompare(b.url)), null, 2));
