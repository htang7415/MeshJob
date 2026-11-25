import { CATALOG } from '../src/catalog.js';
import { collect, detectSource } from '../src/sources.js';

const wwr=CATALOG.find(row=>row.name==='We Work Remotely');
const sources=[ {...wwr,evidenceUrl:'https://weworkremotely.com/remote-job-rss-feed'},
  {...detectSource('https://remotive.com/feed','rss'),name:'Remotive',evidenceUrl:'https://remotive.com/remote-jobs/rss-feed'} ];
const rows=[];
for(const source of sources) {
  const record={url:source.url,permission:source.evidenceUrl,at:new Date().toISOString()};
  try{
    const snapshot=await collect(source);
    record.count=snapshot.items.length;
    record.verifiedPostingTimes=snapshot.items.filter(row=>row.postedAt).length;
    record.attributedLinks=snapshot.items.filter(row=>new URL(row.url).hostname===new URL(source.url).hostname&&row.attribution===source.name).length;
  }catch(error){record.error=error.message;}
  rows.push(record);
}
console.log(JSON.stringify(rows,null,2));
