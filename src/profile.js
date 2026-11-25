import { db, settings } from './db.js';
import { distinctValues, list, SLOTS, structuredValue } from './domain.js';
import { ANSWER_PRESETS, fieldQuestion, PROFILE_KEYS } from './form-rules.js';
import { PRICES, PRICE_VERSION } from './intelligence.js';
import { MAIL_ORIGINS } from './mail.js';
import { COUNTRY_OPTIONS, EMPLOYMENT_TYPES, EXPERIENCE_LEVELS, regionOptions, WORKPLACE_TYPES } from './preferences.js';
import { removeMaterial, saveAnswer, storeMaterial } from './materials.js';
import { previewBackup, restoreBackup } from './portability.js';
import { badge,button,check,dataTable,dateLabel,el,elements,field,formDialog,input,link,money,paragraph,permit,readTokens,rpc,section,select,task,textarea,toast,tokenField } from './ui.js';

const stages=['any','text','textarea','select','combobox','radio','checkbox','number','email','url','date'];
const defaultSelect=(name,material,rows,current)=>field(material,select(name,[['','No default'],...rows.map(row=>[row.id,row.label])],current??''));
const buildForm=(children,submit,label='Save changes')=>el('form',{class:'stack',autocomplete:'off',onsubmit:task(async event=>{
  event.preventDefault();
  await submit(elements(event.currentTarget));
})},children,el('div',{class:'actions'},el('button',{class:'button primary',type:'submit'},label)));
const labels=['Preferences','Personal details','Documents','Verified answers','Integrations','Schedules and budget','Local data'];
const preferenceLists=['titles','countries','locations','seniority','employmentType','workMode'];

export function readPreferences(values) {
  return {
    ...Object.fromEntries(preferenceLists.map(key=>[key,readTokens(values,key)])),
    sponsorship:values.sponsorship||'Unspecified',
    ...(values.freshnessHours ? {freshnessHours:Number(values.freshnessHours)} : {})
  };
}
export function preferencesForm(p,compact=false) {
  const countries=distinctValues(p.countries);
  const regions=tokenField('locations','Regions or cities',p.locations,{
    choices:regionOptions(countries),placeholder:'Add a region, state, or city'
  });
  const country=tokenField('countries','Countries',countries,{
    choices:COUNTRY_OPTIONS,custom:false,change:values=>regions.setChoices(regionOptions(values))
  });
  return el('div',{class:'stack large preference-fields'},
    tokenField('titles','Target job titles',p.titles,{placeholder:'Software engineer, Data analyst'}).root,
    el('div',{class:'form-grid'},country.root,regions.root,
      tokenField('seniority','Experience level',p.seniority,{choices:EXPERIENCE_LEVELS,custom:false}).root,
      tokenField('employmentType','Employment type',p.employmentType,{choices:EMPLOYMENT_TYPES,custom:false}).root,
      tokenField('workMode','Workplace type',p.workMode,{choices:WORKPLACE_TYPES,custom:false}).root,
      field('Visa sponsorship',select('sponsorship',[['Unspecified','No preference'],'Required','Not required'],p.sponsorship)),
      !compact&&field('Date posted',select('freshnessHours',[
        ['24','Past 24 hours'],['168','Past week'],['720','Past month'],
        ...([24,168,720].includes(p.freshnessHours)?[]:[[String(p.freshnessHours),'Past '+p.freshnessHours+' hours']])
      ],String(p.freshnessHours))))
  );
}
function factsForm(config) {
  const fields=Object.entries(PROFILE_KEYS).filter(([key])=>key!=='fullName');
  return buildForm([
    el('div',{class:'form-grid'},fields.map(([key,label])=>field(label,input(key,config.profile[key],{
      type:key==='email'?'email':key==='phone'?'tel':['linkedin','website','github'].includes(key)?'url':'text',maxlength:240
    })))),
    field('Professional summary',textarea('summary',config.profile.summary??'',{maxlength:12000}))
  ],async values=>{
    values.fullName=[values.givenName,values.familyName].filter(Boolean).join(' ');
    await rpc('settings:update',{config:{profile:values}});toast('Profile saved.');
  },'Save profile');
}
function skillsForm(profile) {
  return el('div',{class:'stack'},el('h3',{},'Skills'),
    buildForm(tokenField('skills','Add skills',profile.skills,{placeholder:'Python, PyTorch'}).root,async values=>{
      await rpc('settings:update',{config:{profile:{skills:readTokens(values,'skills')}}});toast('Skills saved.');
    },'Save skills'));
}
const workFields={education:[['school','School'],['degree','Degree'],['field','Field of study'],['gpa','GPA'],['start','Start date'],['end','End date']],
  experience:[['employer','Employer'],['title','Job title'],['location','Location'],['start','Start date'],['end','End date'],['description','Description']]};
function historyDialog(key,index) {
  void (async()=>{
    const profile=(await settings()).profile;
    const rows=profile[key]??[];
    const existing=rows[index]??{};
    const end=input('end',existing.end??'',{type:'date'});
    const endField=field('End date',end);
    const currentRole=key==='experience'&&check('current','I currently work in this role',existing.current===true);
    if(currentRole) {
      const current=currentRole.querySelector('input');
      const sync=()=>{endField.hidden=current.checked;end.disabled=current.checked;};
      current.addEventListener('change',sync);
      sync();
    }
    formDialog(index==null?'Add '+key:'Edit '+key,[el('div',{class:'form-grid'},workFields[key].map(([name,label],i)=>{
      if(name==='end') return [currentRole,endField];
      const current=existing[name]??'';
      const control=name==='description'?textarea(name,current,{maxlength:12000}):
        input(name,current,{type:name==='start'?'date':'text',required:i===0});
      return field(label,control);
    }))],async values=>{
      if(key==='experience') {
        values.current=values.current==='1';
        if(values.current) delete values.end;
      }
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
      [row.start||'Unknown',row.current===true?'Present':row.end||'—'].join(' — '),
      el('div',{class:'actions'},button('Edit',()=>historyDialog(key,i)),button('Remove',()=>drop(i),'danger'))
    ])):paragraph('No '+key+' entries.','meta'));
}
function materialDialog(type,item) {
  const file=input('file','',{type:'file',accept:'.pdf,application/pdf',required:!item});
  const state=el('p',{role:'status'});
  const cancel=button('Cancel extraction',()=>operation?.abort(),'quiet',{hidden:true});
  let operation;
  formDialog((item?'Edit ':'Add ')+(type==='resume'?'resume':'cover letter'),[
    field(item?'Replacement PDF · optional':'PDF file',file),
    field('Label',input('label',item?.label,{maxlength:200})),
    field('Tags',input('tags',item?.tags?.join(', '))),
    el('details',{},el('summary',{},'Review or supply extracted text'),field('Material text',textarea('text',item?.text??'',{maxlength:150000}))),
    state,cancel
  ],async values=>{
    state.textContent=file.files[0]?'Reading PDF locally…':'Saving material…';cancel.hidden=false;
    operation=new AbortController();
    try {
      const text=file.files[0]&&item&&values.text===item.text?'':values.text;
      const result=await storeMaterial({...values,type,text,file:file.files[0],id:item?.id,signal:operation.signal});
      toast(result.warning||'PDF material saved.');
    } finally {state.textContent='';cancel.hidden=true;}
  });
}
function pdfPreview(item) {
  const url=URL.createObjectURL(item.blob);
  window.open(url,'_blank','noopener,noreferrer');
  setTimeout(()=>URL.revokeObjectURL(url),120_000);
}
function documentsView(config,rows) {
  const remove=item=>formDialog('Delete document',[
    paragraph('Delete '+item.name+' from local documents. Application history retains the recorded name and revision.')
  ],async()=>{
    await removeMaterial(item.id);toast('Document deleted.');
  },'Delete document');
  return ['resume','cover'].map(type=>{
    const label=type==='resume'?'Resume':'Cover letter';
    const items=rows.filter(row=>row.type===type);
    const key=type==='resume'?'defaultResume':'defaultCover';
    return el('div',{class:'document-group stack'},
      el('div',{class:'flex between'},el('h3',{},type==='resume'?'Resumes':'Cover letters'),button('Add '+label.toLowerCase(),()=>materialDialog(type))),
      items.length?el('ul',{class:'clean-list'},items.map(item=>el('li',{class:'flex between'},
        el('div',{},el('strong',{},item.label),paragraph(item.name+' · revision '+item.revision,'meta')),
        el('div',{class:'actions'},button('Preview PDF',()=>pdfPreview(item)),button('Edit',()=>materialDialog(type,item)),button('Delete',()=>remove(item),'danger'))
      ))):paragraph('No '+label.toLowerCase()+' PDFs yet.','meta'),
      items.length>0&&buildForm(defaultSelect(key,'Default '+label.toLowerCase(),items,config[key]),async values=>{
        await rpc('settings:update',{config:values});toast('Default document saved.');
      },'Save default'));
  });
}
function answerDialog(answer,preset) {
  const question=preset?.question??answer?.question??'';
  const answerControl=preset?.countries?tokenField('countries','Answer',answer?.value,{
    choices:COUNTRY_OPTIONS,custom:false
  }).root:field('Answer',textarea('value',answer?.value??'',{required:true,maxlength:6000}));
  const choices=preset?.choices&&select(undefined,[['','Choose a suggestion'],...preset.choices],'',{'aria-label':'Suggested answers'});
  choices?.addEventListener('change',()=>{
    if(choices.value)answerControl.querySelector('textarea').value=choices.value;
    choices.value='';
  });
  formDialog(answer?'Edit verified answer':'Add verified answer',[
    preset?el('p',{class:'answer-question'},question):field('Exact question',textarea('question',question,{required:true,maxlength:420})),
    choices&&field('Suggested answers',choices),answerControl,
    !preset&&el('div',{class:'form-grid'},field('Scope',select('scope',['global','company','role'],answer?.scope??'global')),
      field('Company or role, if scoped',input('context',answer?.context,{maxlength:240})),
      field('Form control type',select('type',stages,answer?.type??'any'))),
    check('verified','I verified this answer for the question shown.',false)
  ],async values=>{
    const value=preset?.countries?readTokens(values,'countries').join(', '):values.value;
    if(structuredValue(value))throw new Error('Enter a plain-text answer.');
    await saveAnswer({...values,question:preset?question:values.question,value,id:answer?.id,verified:!!values.verified});
    toast('Verified answer saved.');
  });
}
function removeAnswer(answer) {
  formDialog('Delete verified answer',[paragraph(answer.question)],async()=>{
    await db.answers.delete(answer.id);toast('Answer deleted.');
  },'Delete answer');
}
function answersView(answers) {
  const displayed=new Set();
  const rows=ANSWER_PRESETS.map(preset=>{
    const answer=answers.find(row=>row.verified&&row.scope==='global'&&fieldQuestion(row.questionKey)===fieldQuestion(preset.question));
    if(answer)displayed.add(answer.id);
    return el('li',{class:'answer-row'},el('span',{},preset.question),
      answer?badge(answer.value):el('span',{class:'meta'},'Not set'),
      button(answer?'Edit':'Set answer',()=>answerDialog(answer,preset),'quiet',{'aria-label':(answer?'Edit answer: ':'Set answer: ')+preset.question}),
      answer&&button('Remove',()=>removeAnswer(answer),'quiet',{'aria-label':'Remove answer: '+preset.question}));
  });
  const custom=answers.filter(answer=>!displayed.has(answer.id));
  return [
    el('div',{class:'flex between'},paragraph('Saved answers are optional and require your confirmation.'),button('Add custom answer',()=>answerDialog())),
    el('h3',{},'Work eligibility and equal employment'),el('ul',{class:'clean-list'},rows),
    custom.length>0&&el('h3',{},'Custom answers'),
    custom.length>0&&el('ul',{class:'clean-list'},custom.map(answer=>el('li',{class:'answer-row'},
      el('span',{},answer.question,el('small',{class:'block'},answer.context||answer.scope)),
      badge(answer.value),button('Edit',()=>answerDialog(answer),'quiet'),button('Remove',()=>removeAnswer(answer),'quiet'))))
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
    [factsForm(config),profileHistory(config.profile,'education'),profileHistory(config.profile,'experience'),skillsForm(config.profile)],
    documentsView(config,materials),answersView(answers),integrations(config,health),schedules(config,usage),localData(controls)
  ];
  return el('div',{},el('header',{class:'page-head'},el('div',{},el('h1',{},'Profile'),paragraph('Manage what MeshJob uses for discovery, autofill, and tracking.'))),
    el('div',{class:'layout'},el('aside',{class:'sidebar'},el('nav',{class:'profile-nav','aria-label':'Profile sections'},labels.map((label,i)=>
      el('a',{href:'#profile/'+i,onclick:event=>{event.preventDefault();document.getElementById('profile-'+i)?.scrollIntoView({block:'start'});}},label)))),
    el('div',{class:'stack large'},parts.map((content,i)=>el('section',{class:'section',id:'profile-'+i,style:'scroll-margin-top:95px'},el('h2',{},labels[i]),content)))));
}
