import { db, settings } from './db.js';
import { list, SLOTS } from './domain.js';
import { PROFILE_KEYS } from './form-rules.js';
import { PRICES, PRICE_VERSION } from './intelligence.js';
import { MAIL_ORIGINS } from './mail.js';
import { removeMaterial, saveAnswer, storeMaterial } from './materials.js';
import { previewBackup, restoreBackup } from './portability.js';
import { badge,button,check,dataTable,dateLabel,el,field,formDialog,input,link,money,paragraph,permit,rpc,section,select,task,textarea,toast } from './ui.js';

const preferences=[
  ['titles','Target job titles','e.g. Data analyst, primary school teacher'],
  ['locations','Countries, regions, or cities','e.g. Canada, Berlin'],
  ['seniority','Seniority','e.g. Entry level, Senior'],
  ['employmentType','Employment type','e.g. Full-time, Internship'],
  ['workMode','Work arrangement','e.g. Remote, Hybrid, On-site']
];
const advanced=[
  ['aliases','Additional job title aliases'],['industries','Preferred industries'],['companies','Preferred companies'],['skills','Preferred skills'],
  ['excludeCompanies','Exclude these companies'],['excludeTitles','Exclude these titles or phrases']
];
const stages=['any','text','textarea','select','combobox','radio','checkbox','number','email','url','date'];
const defaultSelect=(name,material,rows,current)=>field(material,select(name,[['','No default'],...rows.map(row=>[row.id,row.label])],current??''));
const buildForm=(children,submit,label='Save changes')=>el('form',{class:'stack',onsubmit:task(async event=>{
  event.preventDefault();
  await submit(Object.fromEntries(new FormData(event.currentTarget)));
})},children,el('div',{class:'actions'},el('button',{class:'button primary',type:'submit'},label)));
const once=(title,item)=>el('span',{class:'inline-group'},el('span',{class:'meta'},title),item);
const labels=['Preferences','Personal details','Materials','Verified answers','Integrations','Schedules and budget','Local data'];

export function readPreferences(values) {
  const output={};
  for(const key of [...preferences,...advanced].map(([key])=>key)) if(key in values) output[key]=list(values[key]);
  for(const key of ['currency','period','sponsorship']) if(key in values) output[key]=values[key];
  if('freshnessHours' in values) output.freshnessHours=Number(values.freshnessHours);
  if('minimumPay' in values) output.minimumPay=Number(values.minimumPay)||null;
  if('strictControl' in values) output.strictUnknown=!!values.strictUnknown;
  return output;
}
export function preferencesForm(preferencesData,compact=false) {
  const row=([key,label,example])=>field(label,input(key,preferencesData[key]?.join(', '),{placeholder:example}),example?'Separate multiple values with commas.':undefined);
  const titleField=row(preferences[0]);
  const presets=['Software engineer','Data analyst','Registered nurse','Product designer','Customer support','Teacher'];
  return el('div',{class:'stack'},
    titleField,compact&&el('div',{class:'actions','aria-label':'Suggested role titles'},presets.map(text=>button(text,()=>{
      const control=titleField.querySelector('input');
      control.value=[...new Set([...list(control.value),text])].join(', ');
      control.focus();
    },'quiet'))),
    el('div',{class:'form-grid'},preferences.slice(1).map(row),
      field('Sponsorship',select('sponsorship',['Unspecified','Required','Not required'],preferencesData.sponsorship)),
      !compact&&field('Freshness window in hours',input('freshnessHours',preferencesData.freshnessHours,{type:'number',min:1,max:720,required:true}))),
    !compact&&el('details',{class:'stack'},el('summary',{},'Advanced preferences'),
      el('div',{class:'form-grid',style:'margin-top:10px'},advanced.map(row),
        field('Minimum compensation',input('minimumPay',preferencesData.minimumPay,{type:'number',min:0,step:'any'})),
        field('Currency',input('currency',preferencesData.currency,{maxlength:3,pattern:'[A-Z]{3}'})),
        field('Compensation period',select('period',['year','month','week','hour'],preferencesData.period)),
        input('strictControl','1',{type:'hidden'}),check('strictUnknown','Exclude jobs when required evidence is missing',preferencesData.strictUnknown)))
  );
}
function factsForm(config) {
  const fields=Object.entries(PROFILE_KEYS).filter(([key])=>key!=='fullName');
  return buildForm([
    el('div',{class:'form-grid'},fields.map(([key,label])=>field(label,input(key,config.profile[key],{
      type:key==='email'?'email':key==='phone'?'tel':['linkedin','website','github'].includes(key)?'url':'text',maxlength:240,autocomplete:'off'
    })))),
    field('Skills',input('skills',config.profile.skills?.join(', '))),
    field('Professional summary',textarea('summary',config.profile.summary??'',{maxlength:12000}))
  ],async values=>{
    const {skills,...rest}=values;
    rest.fullName=[rest.givenName,rest.familyName].filter(Boolean).join(' ');
    await rpc('settings:update',{config:{profile:{...rest,skills:list(skills)}}});toast('Profile saved.');
  },'Save profile');
}
const workFields={education:[['school','School'],['degree','Degree'],['field','Field of study'],['gpa','GPA'],['start','Start date'],['end','End date']],
  experience:[['employer','Employer'],['title','Job title'],['location','Location'],['start','Start date'],['end','End date'],['description','Description']]};
function historyDialog(key,index) {
  void (async()=>{
    const profile=(await settings()).profile;
    const rows=profile[key]??[];
    const existing=rows[index]??{};
    formDialog(index==null?'Add '+key:'Edit '+key,[el('div',{class:'form-grid'},workFields[key].map(([name,label],i)=>{
      const current=existing[name]??'';
      const control=name==='description'?textarea(name,current,{maxlength:12000}):
        input(name,current,{type:['start','end'].includes(name)?'date':'text',required:i===0});
      return field(label,control);
    }))],async values=>{
      const current=(await settings()).profile[key]??[];
      if(index==null) current.push(values);else current[index]=values;
      await rpc('settings:update',{config:{profile:{[key]:current}}});toast('Profile history saved.');
    });
  })().catch(error=>toast(error.message,true));
}
function profileHistory(profile,key) {
  const records=profile[key]??[];
  const drop=index=>formDialog('Remove profile entry',[paragraph('Remove this entry from future autofill plans.')],async()=>{
    const current=(await settings()).profile[key]??[];
    current.splice(index,1);
    await rpc('settings:update',{config:{profile:{[key]:current}}});toast('Removed.');
  },'Remove');
  return el('div',{class:'stack'},
    el('div',{class:'flex between'},el('h3',{},key==='experience'?'Work experience':'Education'),button('Add '+key,()=>historyDialog(key))),
    records.length?dataTable(['Entry','Dates',''],records.map((row,i)=>[
      [row.employer??row.school,row.title??row.degree].filter(Boolean).join(' · '),
      [row.start||'Unknown',row.end||'Present or unknown'].join(' — '),
      el('div',{class:'actions'},button('Edit',()=>historyDialog(key,i)),button('Remove',()=>drop(i),'danger'))
    ])):paragraph('No '+key+' entries.','meta'));
}
function materialDialog(item) {
  const file=input('file','',{type:'file',accept:'.pdf,application/pdf',required:!item});
  const state=el('p',{role:'status'});
  const cancel=button('Cancel extraction',()=>operation?.abort(),'quiet',{hidden:true});
  let operation;
  formDialog(item?'Edit material':'Add PDF material',[
    field(item?'Replacement PDF · optional':'PDF file',file),
    el('div',{class:'form-grid'},field('Material type',select('type',[['resume','Resume'],['cover','Cover letter']],item?.type??'resume')),
      field('Label',input('label',item?.label,{maxlength:200}))),
    field('Tags',input('tags',item?.tags?.join(', '))),
    el('details',{},el('summary',{},'Review or supply extracted text'),field('Material text',textarea('text',item?.text??'',{maxlength:150000}))),
    state,cancel
  ],async values=>{
    state.textContent=file.files[0]?'Reading PDF locally…':'Saving material…';cancel.hidden=false;
    operation=new AbortController();
    try {
      const text=file.files[0]&&item&&values.text===item.text?'':values.text;
      const result=await storeMaterial({...values,text,file:file.files[0],id:item?.id,signal:operation.signal});
      toast(result.warning||'PDF material saved.');
    } finally {state.textContent='';cancel.hidden=true;}
  });
}
function pdfPreview(item) {
  const url=URL.createObjectURL(item.blob);
  window.open(url,'_blank','noopener,noreferrer');
  setTimeout(()=>URL.revokeObjectURL(url),120_000);
}
function materialsView(config,rows) {
  const remove=item=>formDialog('Delete PDF material',[
    paragraph('Delete '+item.name+' from local materials. Application history retains the recorded name and revision.')
  ],async()=>{
    await removeMaterial(item.id);toast('PDF deleted.');
  },'Delete PDF');
  return [
    el('div',{class:'flex between'},paragraph('Upload existing resumes and cover letters. MeshJob extracts text in Chrome.'),button('Add PDF',()=>materialDialog(),'primary')),
    rows.length?dataTable(['Material','Type',''],rows.map(item=>[
      el('div',{class:'stack',style:'gap:2px'},el('strong',{},item.label),paragraph(item.name+' · revision '+item.revision,'meta')),
      item.type==='resume'?'Resume':'Cover letter',
      el('div',{class:'actions'},button('Preview PDF',()=>pdfPreview(item)),button('Edit',()=>materialDialog(item)),button('Delete',()=>remove(item),'danger'))
    ])):paragraph('No PDF materials yet.','meta'),
    rows.length>0&&buildForm(el('div',{class:'form-grid'},defaultSelect('defaultResume','Default resume',rows.filter(row=>row.type==='resume'),config.defaultResume),
      defaultSelect('defaultCover','Default cover letter',rows.filter(row=>row.type==='cover'),config.defaultCover)),async values=>{
      await rpc('settings:update',{config:values});toast('Defaults saved.');
    },'Save defaults')
  ];
}
function answerDialog(answer) {
  formDialog(answer?'Edit verified answer':'Add verified answer',[
    field('Exact question',textarea('question',answer?.question??'',{required:true,maxlength:420})),
    field('Answer',textarea('value',answer?.value??'',{required:true,maxlength:6000})),
    el('div',{class:'form-grid'},field('Scope',select('scope',['global','company','role'],answer?.scope??'global')),
      field('Company or role, if scoped',input('context',answer?.context,{maxlength:240})),
      field('Form control type',select('type',stages,answer?.type??'any'))),
    check('verified','I verified this answer for the question and scope shown.',false)
  ],async values=>{await saveAnswer({...values,id:answer?.id,verified:!!values.verified});toast('Verified answer saved.');});
}
function answersView(answers) {
  return [
    el('div',{class:'flex between'},paragraph('Exact, verified answers can fill matching application questions.'),button('Add answer',()=>answerDialog(),'primary')),
    answers.length?dataTable(['Question','Scope',''],answers.map(answer=>[
      answer.question,answer.scope+(answer.context?' · '+answer.context:''),
      el('div',{class:'actions'},button('Edit',()=>answerDialog(answer)),button('Delete',()=>formDialog('Delete verified answer',[
        paragraph(answer.question)
      ],async()=>{await db.answers.delete(answer.id);toast('Answer deleted.');},'Delete answer'),'danger'))
    ])):paragraph('No verified answers yet.','meta')
  ];
}
function operation(label,type) {
  const id=crypto.randomUUID();
  const status=el('p',{role:'status'},'Working…');
  let done=false;
  const action=button('Cancel',task(async()=>{await rpc('operation:cancel',{op:id});status.textContent='Cancelling…';}));
  const {dialog}=formDialog(label,[status,action]);
  dialog.addEventListener('cancel',e=>{if(!done){e.preventDefault();action.click();}});
  void rpc(type,{op:id}).then(data=>{status.textContent=data?.result ? data.result.accepted+' recruitment events · '+data.result.urgent+' urgent.':'Completed. See integration status.';},
    error=>{status.textContent=error.message;}).finally(()=>{done=true;action.replaceWith(button('Close',()=>dialog.close(),'primary'));});
}
function integrations(config,health) {
  const indicators={claude:el('span'),password:el('span'),gmail:el('span')};
  const refresh=async()=>{
    const data=await rpc('integrations:status');
    indicators.claude.replaceChildren(badge(data.claude?'Key stored':'Optional',data.claude?'ok':'muted'));
    indicators.password.replaceChildren(badge(data.password?(data.persistent?'Local plaintext':'Session only'):'Off',data.password?'warn':'muted'));
    indicators.gmail.replaceChildren(badge(!data.gmailConfigured?'OAuth build needed':config.gmail?'Connected':'Optional',config.gmail?'ok':'muted'));
  };
  void refresh().catch(()=>{});
  const claudeKey=()=>formDialog('Claude API key',[
    field('Personal Claude API key',input('key','',{type:'password',autocomplete:'off',required:true})),
    paragraph('Chrome stores the key locally in trusted MeshJob contexts. It is not encrypted by MeshJob. Paid requests send relevant excerpts to Anthropic.')
  ],async ({key})=>{
    await permit(['https://api.anthropic.com/*']);
    await rpc('secret:claude',{key});await refresh();toast('Claude key stored.');
  },'Connect Claude');
  const gmail=modify=>task(async()=>{
    const current=await rpc('integrations:status');
    if(!current.gmailConfigured) throw new Error('Build MeshJob with your Google Chrome Extension OAuth client first. See the README.');
    await permit(MAIL_ORIGINS,['identity']);
    await rpc('gmail:connect',{modify});toast(modify?'Gmail modify access granted.':'Gmail read-only access granted.');
  });
  const password=()=>formDialog('Registration password',[
    field('Password',input('value','',{type:'password',autocomplete:'new-password',required:true,maxlength:256})),
    paragraph('Chrome Password Manager can create unique credentials. MeshJob can fill this value when you explicitly request it on a verified registration form.'),
    check('persist','Keep this password in local plaintext between Chrome sessions'),
    check('consent','I understand the plaintext and password-reuse risks.')
  ],async values=>{
    await rpc('secret:password',{value:values.value,persist:!!values.persist,consent:!!values.consent});await refresh();toast('Registration password set.');
  },'Set password');
  return [
    el('div',{class:'stack'},el('div',{class:'flex between'},el('h3',{},'Claude'),indicators.claude),
      paragraph('Bring your own key for matching, web search, and reviewed autofill suggestions.'),
      el('div',{class:'actions'},button('Set API key',claudeKey),button('Clear key',task(async()=>{await rpc('secret:claude',{key:''});await refresh();},'Claude key cleared.')))),
    el('div',{class:'stack'},el('div',{class:'flex between'},el('h3',{},'Gmail'),indicators.gmail),
      paragraph(config.gmail?config.markRead?'Modify consent granted. Only eligible routine messages can be marked read.':'Read-only consent granted.':'Connect a Gmail account for recruitment updates and urgent alerts.'),
      health?.successAt&&paragraph('Last sync '+dateLabel(health.successAt),'meta'),
      health?.attemptAt&&paragraph('Last attempt '+dateLabel(health.attemptAt),'meta'),
      health?.error&&paragraph(health.error,'form-error'),
      el('div',{class:'actions'},!config.gmail&&button('Connect read-only',gmail(false)),
        config.gmail&&button('Sync now',()=>operation('Sync Gmail','gmail:sync')),
        config.gmail&&!config.markRead&&button('Enable routine mark-read',()=>formDialog('Enable routine mark-read',[
          paragraph('When a routine confirmation or rejection is confidently linked and stored, MeshJob can remove its unread label. Actionable and ambiguous messages stay unread.'),
          button('Request modify access',gmail(true),'primary')
        ])),
        config.markRead&&button('Turn off mark-read',task(()=>rpc('gmail:readonly'),'Automatic mark-read turned off.')),
        config.gmail&&button('Disconnect',()=>formDialog('Disconnect Gmail',[
          paragraph('Previously recorded events remain available.'),
          check('revoke','Also revoke Google access')
        ],async values=>{await rpc('gmail:disconnect',{revoke:!!values.revoke});toast('Gmail disconnected.');},'Disconnect')),
        button('Test notification',task(()=>rpc('notification:test'),'Test notification requested.'))),
      buildForm(el('div',{class:'form-grid'},field('Recovery window in days',input('gmailDays',config.gmailDays,{type:'number',min:1,max:45,required:true})),
        field('Additional Gmail recovery query',input('gmailFilter',config.gmailFilter??'',{maxlength:180})),
        check('mailAI','Use Claude to review excerpts of ambiguous urgent messages',config.mailAI??false)),
      async values=>{
        await rpc('settings:update',{config:{gmailDays:Number(values.gmailDays),gmailFilter:values.gmailFilter,mailAI:!!values.mailAI}});toast('Gmail scope saved.');
      },'Save Gmail settings')),
    el('div',{class:'stack'},el('div',{class:'flex between'},el('h3',{},'Registration password'),indicators.password),
      el('div',{class:'actions'},button('Set password',password),button('Clear password',task(async()=>{await rpc('secret:password',{value:''});await refresh();},'Registration password removed.'))))
  ];
}
function schedules(config,usage) {
  const models=Object.keys(PRICES);
  const month=new Date().toLocaleDateString('en-CA',{year:'numeric',month:'2-digit'});
  const spent=usage.filter(row=>row.month===month).reduce((total,row)=>total+row.cost,0);
  return buildForm([
    el('div',{class:'form-grid'},
      field('Claude search times · local clock',input('slots',config.slots.join(', '),{placeholder:SLOTS.join(', ')}),'Separate times with commas.'),
      field('Web searches per round',input('searchesPerRound',config.searchesPerRound,{type:'number',min:1,max:5,required:true})),
      field('Rounds per day',input('roundsPerDay',config.roundsPerDay,{type:'number',min:0,max:12,required:true})),
      field('Monthly budget · USD',input('budget',config.budget,{type:'number',min:0,max:10000,step:'.01',required:true})),
      field('Daily budget · USD',input('dailyBudget',config.dailyBudget,{type:'number',min:0,max:10000,step:'.01',required:true})),
      field('Per request budget · USD',input('runBudget',config.runBudget,{type:'number',min:0,max:10000,step:'.01',required:true})),
      field('Matching and classification model',select('model',models,config.model)),field('Open-ended answer model',select('draftModel',models,config.draftModel)),
      field('Job description retention in days',input('jdDays',config.jdDays,{type:'number',min:1,max:3650,required:true})),
      field('Closed job detail retention in days',input('tombstoneDays',config.tombstoneDays,{type:'number',min:1,max:3650,required:true}))),
    check('autoMatch','Automatically evaluate eligible new jobs when Claude is connected',config.autoMatch),
    check('directAlerts','Notify me about verified recent jobs',config.directAlerts),
    check('advance','Allow reviewed non-final Workday navigation',config.advance),
    paragraph('Estimated or reserved this month '+money(spent)+' · Pricing checked '+PRICE_VERSION+'. App-side limits estimate usage. Check your provider billing controls.'),
    link('Claude model and tool prices','https://platform.claude.com/docs/en/about-claude/pricing')
  ],async values=>{
    const keys=['searchesPerRound','roundsPerDay','budget','dailyBudget','runBudget','jdDays','tombstoneDays'];
    const patch=Object.fromEntries(keys.map(key=>[key,Number(values[key])]));
    Object.assign(patch,{slots:list(values.slots),model:values.model,draftModel:values.draftModel,autoMatch:!!values.autoMatch,directAlerts:!!values.directAlerts,advance:!!values.advance});
    await rpc('settings:update',{config:patch});toast('Schedules and budget saved.');
  },'Save schedules');
}
function restoreDialog() {
  const file=input('backup','',{type:'file',accept:'.zip,application/zip',required:true});
  const details=el('div',{class:'stack'});
  const {dialog}=formDialog('Import a MeshJob backup',[
    field('Backup ZIP',file),details
  ],async ()=>{
    if(!file.files[0]) throw new Error('Choose a backup ZIP.');
    const snapshot=await previewBackup(file.files[0]);
    const counts=Object.keys(snapshot.records).filter(key=>Array.isArray(snapshot.records[key])).map(key=>[key,snapshot.records[key].length]);
    const selected=select('mode',[['merge','Merge new records into this profile'],['replace','Replace all local records']],'merge');
    details.replaceChildren(paragraph('Checksums verified · exported '+dateLabel(snapshot.manifest.exportedAt)),
      dataTable(['Records','Count'],counts),field('Restore mode',selected),
      button('Restore verified backup',()=>{
        if(selected.value==='replace') {
          formDialog('Replace local MeshJob records',[
            paragraph('This removes current jobs, applications, history, sources, answers, and PDFs. Export a backup of this profile before continuing.'),
            check('confirm','I want to replace local records.')
          ],async values=>{
            if(!values.confirm) throw new Error('Confirm local replacement.');
            await rpc('mode:set',{mode:'Paused'});
            const result=await restoreBackup(snapshot,'replace');dialog.close();toast(result.applications+' applications restored.');
          },'Replace local records');
        } else task(async()=>{
          const result=await restoreBackup(snapshot,'merge');dialog.close();toast(result.applications+' applications added.');
        })();
      },'primary'));
    return false;
  },'Verify and preview');
}
function localData({backup,storageHelp}) {
  const estimate=el('p',{class:'meta'},'Checking browser storage…');
  if(navigator.storage?.estimate) void navigator.storage.estimate().then(data=>{
    estimate.textContent=typeof data.usage==='number'?'Chrome reports '+(data.usage/1048576).toFixed(2)+' MiB in use for this extension.':'Storage estimate unavailable.';
  }).catch(()=>{estimate.textContent='Storage estimate unavailable.';});
  return [
    paragraph('Backups include personal records, verified answers, and PDF files. Credentials stay in this Chrome profile. Export before uninstalling.'),
    estimate,el('div',{class:'actions'},button('Download backup ZIP',task(backup),'primary'),button('Import backup ZIP',restoreDialog),button('Storage details',storageHelp),
      button('Clear all MeshJob data',()=>formDialog('Clear local MeshJob data',[
        paragraph('This permanently removes MeshJob records and local credentials on this device. You can export a backup first.'),
        button('Download a backup',task(backup)),field('Type DELETE to confirm',input('confirm','',{required:true,pattern:'DELETE'}))
      ],async values=>{await rpc('data:clear',{confirm:values.confirm});toast('Local MeshJob data cleared.');},'Permanently delete'),'danger'))
  ];
}
export function profileView({config,materials,answers,health,usage},controls) {
  const parts=[
    buildForm(preferencesForm(config.preferences),async values=>{await rpc('settings:update',{config:{preferences:readPreferences(values)}});toast('Search preferences saved.');},'Save preferences'),
    [factsForm(config),profileHistory(config.profile,'education'),profileHistory(config.profile,'experience')],
    materialsView(config,materials),answersView(answers),integrations(config,health),schedules(config,usage),localData(controls)
  ];
  return el('div',{},el('header',{class:'page-head'},el('div',{},el('h1',{},'Profile'),paragraph('Manage what MeshJob uses for discovery, autofill, and tracking.'))),
    el('div',{class:'layout'},el('aside',{class:'sidebar'},el('nav',{class:'profile-nav','aria-label':'Profile sections'},labels.map((label,i)=>
      el('a',{href:'#profile/'+i,onclick:event=>{event.preventDefault();document.getElementById('profile-'+i)?.scrollIntoView({block:'start'});}},label)))),
    el('div',{class:'stack large'},parts.map((content,i)=>el('section',{class:'section',id:'profile-'+i,style:'scroll-margin-top:95px'},el('h2',{},labels[i]),content)))));
}
