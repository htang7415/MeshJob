// Independent API references. Probe public read endpoints only.
export const boards = {
  greenhouse: ['anthropic','figma','notion','databricks','roblox','stripe','coinbase','cloudflare','mongodb','reddit','scaleai','brex','doordash','discord','waymo','deepmind'],
  ashby: ['ramp','linear','notion','openai','cursor','retool','mercury','deel','remote','supabase','perplexity','elevenlabs','vanta','clickhouse','vercel','incident.io'],
  lever: ['netflix','spotify','palantir','plaid','anduril','fivetran','dhi','hive','skydio','relativityspace','shieldai','zoox','appian','superhuman','rizelab','shopback']
};
export function referenceUrl(provider, board) {
  return {
    greenhouse: 'https://boards-api.greenhouse.io/v1/boards/' + board + '/jobs',
    ashby: 'https://api.ashbyhq.com/posting-api/job-board/' + board,
    lever: 'https://api.lever.co/v0/postings/' + board + '?mode=json'
  }[provider];
}
