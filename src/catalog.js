import { detectSource } from './sources.js';

export const CATALOG_VERSION = '2026-11-27.1';
const publicBoards = [
  ['https://job-boards.greenhouse.io/','Greenhouse',[
    ['anthropic','Anthropic'],['brex','Brex'],['cloudflare','Cloudflare'],['coinbase','Coinbase'],['databricks','Databricks'],
    ['discord','Discord'],['figma','Figma'],['mongodb','MongoDB'],['reddit','Reddit'],['roblox','Roblox'],['scaleai','Scale AI'],['stripe','Stripe'],['waymo','Waymo']
  ]],
  ['https://jobs.ashbyhq.com/','Ashby',[
    ['clickhouse','ClickHouse'],['cursor','Cursor'],['deel','Deel'],['elevenlabs','ElevenLabs'],['linear','Linear'],['mercury','Mercury'],
    ['notion','Notion'],['openai','OpenAI'],['perplexity','Perplexity'],['ramp','Ramp'],['supabase','Supabase'],['vanta','Vanta'],['vercel','Vercel']
  ]],
  ['https://jobs.lever.co/','Lever',[['hive','Hive'],['palantir','Palantir'],['shieldai','Shield AI'],['spotify','Spotify'],['zoox','Zoox']]]
];
export const CATALOG = [
  ...publicBoards.flatMap(([prefix, method, teams]) => teams.map(([token,name]) => ({
    ...detectSource(prefix+token), name, method:'Public '+method+' posting API', catalog:CATALOG_VERSION, verifiedAt:'2026-11-25'
  }))),
  {...detectSource('https://weworkremotely.com/remote-jobs.rss'),name:'We Work Remotely',method:'Public RSS feed',catalog:CATALOG_VERSION,optional:true},
  ...[
    ['https://github.com/SimplifyJobs/New-Grad-Positions/blob/dev/.github/scripts/listings.json','SimplifyJobs New Grad (1,000+ companies)'],
    ['https://github.com/SimplifyJobs/Summer2026-Internships/blob/dev/.github/scripts/listings.json','SimplifyJobs Internships (1,000+ companies)'],
    ['https://github.com/speedyapply/2027-SWE-College-Jobs/blob/main/NEW_GRAD_USA.md','SpeedyApply SWE New Grad USA'],
    ['https://github.com/speedyapply/2027-AI-College-Jobs/blob/main/NEW_GRAD_USA.md','SpeedyApply AI New Grad USA']
  ].map(([url,name])=>({...detectSource(url),name,interval:url.endsWith('.json')?30:10,method:url.endsWith('.json')?'Public aggregated JSON list':'Public Markdown list',catalog:CATALOG_VERSION,optional:true}))
];
