import { classifyMail } from '../src/mail.js';
import { preferenceDecision, normalized } from '../src/domain.js';
import { roleGroups } from '../test/fixtures/roles.mjs';
import { ambiguousUrgent,mailFixtures } from '../test/fixtures/mail.mjs';
const roles=roleGroups.flatMap(([target,rows])=>rows.map(([title,description,expected])=>{
  const actual=preferenceDecision({title},{titles:[target]}).eligible;
  return {target,title,expected,actual};
}));
const categories=Object.entries(mailFixtures).flatMap(([expected,rows])=>rows.map(([subject,snippet])=>({
  subject,snippet,expected,urgent:['assessment','interview','follow-up','offer'].includes(expected)
}))).concat(ambiguousUrgent.map(([subject,snippet])=>({subject,snippet,expected:null,urgent:true})));
const emails=categories.map(row=>({...row,actual:classifyMail({subject:row.subject,snippet:row.snippet,from:'case@fixture.invalid'})}));
const relevant=roles.filter(row=>row.expected);
const included=roles.filter(row=>row.actual);
const classified=emails.filter(row=>row.expected!==null);
const urgency=emails.filter(row=>row.urgent);
const alerts=emails.filter(row=>row.actual.urgent);
const pairs={
  roles:{n:roles.length,groups:roleGroups.length,recall:[relevant.filter(row=>row.actual).length,relevant.length],
    initialPrecision:[included.filter(row=>row.expected).length,included.length],misses:roles.filter(row=>row.expected&&!row.actual)},
  emails:{n:emails.length,classification:[classified.filter(row=>row.expected===row.actual.category).length,classified.length],
    urgentRecall:[urgency.filter(row=>row.actual.urgent).length,urgency.length],urgentPrecision:[alerts.filter(row=>row.urgent).length,alerts.length],
    missedUrgent:urgency.filter(row=>!row.actual.urgent).map(row=>row.subject),categoryDifferences:classified.filter(row=>row.expected!==row.actual.category).map(({subject,expected,actual})=>({subject,expected,actual:actual.category}))}
};
console.log(JSON.stringify(pairs,null,2));
