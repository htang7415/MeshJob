import { readFile } from 'node:fs/promises';
import { classifyMail, linkMail } from '../src/mail.js';
import { preferenceDecision } from '../src/domain.js';

const [type,file]=process.argv.slice(2);
if(!file||!['roles','mail'].includes(type)) throw new Error('Usage: node scripts/verify-corpus.mjs roles|mail path-to-labeled.json');
const input=JSON.parse(await readFile(file,'utf8'));
if(!Array.isArray(input)||!input.length)throw new Error('Expected an array of labeled cases.');
const pair=(rows,predicate)=>({correct:rows.filter(predicate).length,total:rows.length});
if(type==='roles') {
  const cases=input.map(({job,preferences,relevant})=>{
    if(typeof relevant!=='boolean'||!job||!preferences)throw new Error('Expected job, preferences and boolean relevant.');
    return {relevant,retained:preferenceDecision(job,preferences).eligible};
  });
  console.log(JSON.stringify({sample:cases.length,recall:pair(cases.filter(row=>row.relevant),row=>row.retained),
    initialPrecision:pair(cases.filter(row=>row.retained),row=>row.relevant)},null,2));
} else {
  const cases=input.map(({mail,applications,history,category,urgent,applicationId})=>{
    if(!mail||!Array.isArray(applications)||typeof urgent!=='boolean')throw new Error('Expected message, application context and a boolean urgency label.');
    const actual=classifyMail(mail);
    const linked=linkMail(mail,applications,history)?.id??null;
    return {actual,linked,category,urgent,applicationId};
  });
  console.log(JSON.stringify({sample:cases.length,classification:pair(cases.filter(row=>row.category!=null),row=>row.category===row.actual.category),
    linking:pair(cases.filter(row=>row.applicationId!==undefined),row=>row.applicationId===row.linked),
    urgentRecall:pair(cases.filter(row=>row.urgent),row=>row.actual.urgent),
    urgentPrecision:pair(cases.filter(row=>row.actual.urgent),row=>row.urgent)},null,2));
}
