import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, freshness, localSlot, canonicalUrl, preferenceDecision, sponsorshipEvidence, matchScore } from '../src/domain.js';
import { collect, detectSource, postingIdentity } from '../src/sources.js';
import { createFillPlan, fieldKey } from '../src/form-rules.js';

test('canonical URLs preserve requisitions and unknown meaningful parameters',()=>{
  assert.equal(canonicalUrl('https://example.com/jobs/?source=job-1&gh_jid=5&utm_medium=social#map'),'https://example.com/jobs?gh_jid=5&source=job-1');
  assert.notEqual(canonicalUrl('https://example.com/jobs?jobId=1'),canonicalUrl('https://example.com/jobs?jobId=2'));
  assert.equal(postingIdentity('https://jobs.lever.co/team/13e1e478-6330-47c5-9fb0-d07889111cc2').key,
    postingIdentity('https://jobs.lever.co/team/13e1e478-6330-47c5-9fb0-d07889111cc2/apply').key);
  assert.equal(postingIdentity('https://job-boards.greenhouse.io/example/jobs/123').externalId,'123');
  assert.notEqual(detectSource('https://jobs.eu.lever.co/team').id,detectSource('https://jobs.lever.co/team').id);
  assert.throws(()=>detectSource('https://linkedin.com/jobs'));
  assert.throws(()=>detectSource('https://localhost/jobs'));
});
test('freshness requires original posting evidence and keeps observation bounds separate',()=>{
  const at=Date.parse('2026-10-18T15:00:00Z');
  const item={active:true,official:true,firstSeenAt:'2026-10-18T13:55:00Z',lastAbsentAt:'2026-10-18T13:45:00Z',updatedAt:'2026-10-18T13:48:00Z'};
  assert.equal(freshness(item,24,at),'detected');
  assert.equal(freshness({...item,lastAbsentAt:null},24,at),'unknown');
  assert.equal(freshness({...item,reopenedAt:'2026-10-18T13:55:00Z'},24,at),'unknown');
  assert.equal(freshness({...item,postedAt:'2026-10-18'},24,at),'detected');
  assert.equal(freshness({...item,postedAt:'2026-10-18T12:34:56Z'},24,at),'verified');
  assert.equal(freshness({...item,postedAt:'2026-10-16T12:34:56Z'},24,at),'older');
  assert.equal(freshness({...item,official:false,postedAt:'2026-10-18T12:34:56Z'},24,at),'detected');
});
test('wall clock slots have stable date keys and narrow non-replay windows',()=>{
  const at=(day,h,m)=>new Date(2026,10,day,h,m,0);
  assert.equal(localSlot(at(1,18,30),DEFAULTS.slots).key,'slot:2026-11-01:18:30');
  assert.equal(localSlot(at(1,18,31),DEFAULTS.slots).key,'slot:2026-11-01:18:30');
  assert.equal(localSlot(at(1,18,42),DEFAULTS.slots).key,undefined);
  assert.equal(localSlot(at(2,8,30),DEFAULTS.slots).key,'slot:2026-11-02:08:30');
});
test('visa evidence keeps unknowns and ignores unsupported history exclusions',()=>{
  const policy={sponsorship:'Required'};
  for(const text of ['Our startup has no immigration filings.','Will you now or in the future require sponsorship?','STEM OPT applicants are welcome.','We may consider visa sponsorship.']) {
    const sponsorship=sponsorshipEvidence(text,'https://careers.example.com/roles/123');
    assert.equal(sponsorship.status,'Unknown',text);
    assert.equal(preferenceDecision({title:'Engineer',sponsorship},policy).eligible,true,text);
  }
  assert.equal(sponsorshipEvidence('Visa sponsorship is available for this role.').status,'Confirmed');
  assert.equal(sponsorshipEvidence('Visa sponsorship is available for this role. We cannot offer visa sponsorship.').status,'Unknown');
  assert.equal(sponsorshipEvidence('We cannot offer visa sponsorship.',undefined,[{kind:'history',status:'Likely'}]).status,'Not Supported');
  assert.equal(sponsorshipEvidence('No stated policy',undefined,[{kind:'history',status:'Likely'}]).status,'Likely');
  assert.equal(sponsorshipEvidence('No stated policy',undefined,[{kind:'history',status:'Not Supported'}]).status,'Unknown');
  assert.equal(matchScore({skills:100,experience:50,seniority:50,domain:0}),65);
});
test('only exact verified answers can fill critical fields and no answer can automate consent',()=>{
  const fields=[
    {id:'a',label:'Will you require sponsorship?',type:'radio',critical:true},
    {id:'b',label:'Are you authorized to work?',type:'radio',critical:true},
    {id:'c',label:'I agree to the privacy notice',type:'checkbox'},
    {id:'d',label:'First name',type:'text',filled:true},
    {id:'e',label:'Personal email',type:'email'},
    {id:'f',label:'Start year',type:'text',group:{kind:'experience',index:1}},
    {id:'g',label:'GitHub profile URL',type:'url'}
  ];
  const answers=[
    {questionKey:'will you require sponsorship',verified:true,value:'Yes',type:'radio',scope:'company',context:'Example Industries'},
    {questionKey:'are you authorized to work',verified:true,value:'Yes',type:'radio',scope:'company',context:'Different Industries'},
    {questionKey:'i agree to the privacy notice',verified:true,value:'Yes',type:'any',scope:'global'}
  ];
  const plan=createFillPlan(fields,{job:{company:'Example Industries'},answers,profile:{
    givenName:'Taylor',email:'fixture@example.invalid',experience:[{}, {start:'2024-03-01'}],github:'https://github.com/example'
  },maps:[{id:'b',key:'email'}],drafts:[{id:'c',answer:'yes'}]});
  assert.deepEqual(plan.map(row=>[row.id,row.value]),[['a','Yes'],['e','fixture@example.invalid'],['f','2024'],['g','https://github.com/example']]);
  assert.equal(fieldKey({type:'file',label:'cover letter',name:'attachment'}),'cover');
});
test('Workday requires permission, completes all pages, and rejects a broken snapshot',async()=>{
  const src=detectSource('https://example.wd5.myworkdayjobs.com/en-US/Careers');
  const page=(offset,count,duplicate=false)=>Array.from({length:count},(_,i)=>({
    title:'Example '+(offset+i),externalPath:'/job/Remote/Example_'+(duplicate?0:offset+i),locationsText:'Remote',postedOn:'Posted Today'
  }));
  const bodies=[];
  const fetcher=async (url,options)=>{
    bodies.push(options.body.offset);
    return Response.json({total:21,jobPostings:options.body.offset===0?page(0,20):page(20,1)});
  };
  await assert.rejects(()=>collect(src,{fetcher}),/permits/);
  const full=await collect({...src,permitted:true},{fetcher});
  assert.deepEqual(bodies,[0,20]);
  assert.equal(full.items.length,21);
  assert.ok(full.items.every(row=>row.postedAt===null));
  await assert.rejects(()=>collect({...src,permitted:true},{fetcher:async()=>Response.json({total:21,jobPostings:page(0,20,true)})}),/incomplete|duplicate|repeated/);
});
test('public dates are interpreted with provider-specific semantics',async()=>{
  const ashby=detectSource('https://jobs.ashbyhq.com/example');
  const uuid='13e1e478-6330-47c5-9fb0-d07889111cc2';
  const json=Response.json({jobs:[
    {isListed:true,jobUrl:'https://jobs.ashbyhq.com/example/'+uuid,publishedAt:'2026-10-18T00:00:00Z',title:'Developer'},
    {isListed:false,jobUrl:'https://jobs.ashbyhq.com/example/'+uuid,title:'Unlisted'}
  ]});
  const {items}=await collect(ashby,{fetcher:async()=>json});
  assert.equal(items.length,1);assert.equal(items[0].postedAt,null);assert.equal(items[0].updatedAt,'2026-10-18T00:00:00Z');
  const careers=detectSource('https://careers.example.com/jobs');
  const row={title:'Developer',datePosted:'2026-10-18T00:00:00Z',url:'https://careers.example.com/jobs/1','@type':'JobPosting',description:'<p>Example</p>'};
  const page=new Response('<script type="application/ld+json">'+JSON.stringify(row)+'</script>');
  const data=await collect(careers,{fetcher:async()=>page});
  assert.equal(data.items[0].dateEvidence.kind,'JobPosting.datePosted');
  assert.ok(data.items[0].postedAt);
});

test('receipt classifier rejects generic, conditional, failed and untrusted confirmation text',async()=>{
  const { receiptSignature, RECEIPT_SELECTORS }=await import('../src/form-rules.js');
  const passed=['Application submitted','Application has been received','We received your application','Thank you for submitting your application',
    'Your application was submitted','Your application is complete','Thank you for applying','We submitted your application'];
  const rejected=['Thanks for visiting','Your application has not been submitted','Application submitted? An error submitting interrupted the process',
    'If you submit, your application is complete','Application submitted earlier. This application was saved as a draft application.',
    'Application was not received','Your application has been started','Please submit your application','Please review the application',
    'Close this window','Your application failed','Thank you for your interest','Your confirmation code is 1234','Unable to submit your application',
    'Scheduling confirmation','Expected application received status will appear after the form is sent'];
  const expectations=[];
  for(const [provider,selectors] of Object.entries(RECEIPT_SELECTORS)){
    for(const text of passed) expectations.push([{provider,marker:selectors[0],text,finalVisible:false},true]);
    for(const text of rejected) expectations.push([{provider,marker:selectors[0],text,finalVisible:false},false]);
    for(const text of passed.slice(0,5)) expectations.push([{provider,marker:selectors[0],text,finalVisible:true},false]);
    for(const text of passed.slice(0,3)) expectations.push([{provider,marker:'.generic-banner',text,finalVisible:false},false]);
  }
  for(const [sample,wanted] of expectations) assert.equal(!!receiptSignature(sample),wanted,JSON.stringify(sample));
  assert.equal(expectations.length,128);
});

test('RSS and Atom tolerate optional fields and keep feed dates as syndication evidence',async()=>{
  const rss=detectSource('https://example.com/feed');
  const response=new Response(`<?xml version="1.0"?><rss version="2.0"><channel>
    <item><title>Registered Nurse</title><link>https://example.com/jobs/12</link><pubDate>Tue, 18 Oct 2026 11:00:00 GMT</pubDate></item>
    <item><title>Data Analyst</title><link>https://example.com/jobs/13</link><company>Example Org</company></item>
  </channel></rss>`);
  const {items}=await collect(rss,{fetcher:async()=>response});
  assert.equal(items.length,2);assert.equal(items[0].official,false);assert.equal(items[0].postedAt,null);
  assert.equal(items[0].company,'Unknown employer');assert.equal(items[1].company,'Example Org');
  const atom=new Response(`<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Designer</title>
    <link rel="self" href="https://example.com/api/12"/><link rel="alternate" href="https://example.com/jobs/25"/></entry></feed>`);
  assert.equal((await collect(rss,{fetcher:async()=>atom})).items[0].url,'https://example.com/jobs/25');
});

test('Workday respects an explicit robots directive before listing requests',async()=>{
  const {respectWorkdayRobots}=await import('../src/sources.js');
  const source={...detectSource('https://example.wd5.myworkdayjobs.com/Careers'),permitted:true};
  const fetcher=async url=>{
    assert.equal(url,source.origin+'/robots.txt');
    return new Response('User-agent: *\nDisallow: /wday/cxs/\nAllow: /Careers\n');
  };
  await assert.rejects(()=>respectWorkdayRobots(source,fetcher),/disallows/);
  await respectWorkdayRobots(source,async()=>new Response('User-agent: *\nDisallow: /private\n'));
});

test('a truncated RSS document cannot replace a complete snapshot',async()=>{
  const source=detectSource('https://example.com/feed');
  await assert.rejects(()=>collect(source,{fetcher:async()=>new Response('<rss><channel><item><title>Partial</title><link>https://example.com/jobs/1</link></item>')}),/incomplete/);
});

test('saved profile values stay plain and only explicit work details fill guarded controls',async()=>{
  const {distinctValues,structuredValue}=await import('../src/domain.js');
  const {ANSWER_PRESETS, createFillPlan, fieldQuestion, criticalField}=await import('../src/form-rules.js');
  assert.equal(structuredValue('[{"interestingType":"INDUSTRY","_delete":true}]'),true);
  assert.deepEqual(distinctValues('[{"interestingType":"INDUSTRY"},{"id":"2"}]'),[]);
  assert.deepEqual(distinctValues('Python,PyTorch,python,C++,C#'),['Python','PyTorch','C++','C#']);
  assert.equal(ANSWER_PRESETS.length,14);
  assert.ok(criticalField('Do you identify as LGBTQ+?'));
  assert.equal(fieldQuestion('Are you a U.S. citizen?'),fieldQuestion('Are you a citizen of the United States?'));
  assert.notEqual(fieldQuestion('Are you authorized to work?'),fieldQuestion('Are you authorized to work in the United States?'));
  const group={kind:'experience',index:0};
  const fields=[
    {id:'work',type:'checkbox',group,label:'I currently work here'},
    {id:'end',type:'date',group,label:'End date'},
    {id:'skills',type:'skill-picker',label:'Skills',filled:true},
    {id:'notmine',type:'email',label:"Recruiter's email",name:'email',autocomplete:'email'},
    {id:'industry',type:'text',label:'Preferred industries',name:'company',autocomplete:'organization'},
    {id:'lgbtq',type:'text',label:'Do you identify as LGBTQ+?'},
    {id:'us',type:'radio',label:'Are you a U.S. citizen?'}
  ];
  const profile={experience:[{current:true,end:'2026-02-13'}],skills:['Python','C++'],email:'fixture@example.invalid',currentEmployer:'Example'};
  const answers=[{verified:true,type:'any',scope:'global',questionKey:fieldQuestion('Are you a citizen of the United States?'),value:'Yes'}];
  const plan=createFillPlan(fields,{profile,answers});
  assert.deepEqual(plan.map(item=>item.id),['work','skills','us']);
  assert.deepEqual(plan[1].skills,['Python','C++']);
});

test('experience and country selectors apply supported evidence and retain unknowns',()=>{
  const preferences={countries:['Canada'],seniority:['Mid-Senior level'],workMode:['On-site'],locations:['Ontario']};
  const match={title:'Software Engineer',seniority:'Senior',workMode:'Onsite',location:'Toronto',locationDetails:'Toronto, Ontario, Canada',
    countries:['Canada'],locationCertain:true};
  assert.ok(preferenceDecision(match,preferences).eligible);
  assert.ok(!preferenceDecision({...match,countries:['United States']},preferences).eligible);
  const uncertain=preferenceDecision({title:'Software Engineer'},preferences);
  assert.ok(uncertain.eligible);assert.ok(uncertain.unknown.includes('Country'));
});

test('stats windows group applications by local submission date',async()=>{
  const {statsPeriod,analyze}=await import('../src/stats.js');
  const local=(m,d)=>new Date(2026,m,d,12).toISOString();
  const apps=[{id:'week',appliedAt:local(10,25),status:'Interview'},{id:'month',appliedAt:local(10,2),status:'Offer'},
    {id:'year',appliedAt:local(2,1),status:'Rejected'},{id:'draft',status:'Preparing'}];
  for(const [period,total] of Object.entries({week:1,month:2,year:3,all:3})) {
    const summary=analyze({applications:apps,events:[],range:statsPeriod(period,new Date(2026,10,25,13))});
    assert.equal(summary.overall.applications,total,period);
    assert.equal(summary.drafts,1);
  }
});
