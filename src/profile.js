import { db, settings } from './db.js';
import { ATS_ORIGINS, structuredValue } from './domain.js';
import { ANSWER_PRESETS, fieldQuestion, PROFILE_KEYS } from './form-rules.js';
import { PRICES, PRICE_VERSION } from './intelligence.js';
import { MAIL_PROVIDERS } from './mail.js';
import { COUNTRY_OPTIONS } from './preferences.js';
import { removeMaterial, saveAnswer, storeMaterial, versionLabel } from './materials.js';
import { previewBackup, restoreBackup } from './portability.js';
import { badge,button,check,dataTable,dateLabel,el,elements,field,formDialog,input,link,money,paragraph,permit,readTokens,rpc,select,task,textarea,toast,tokenField } from './ui.js';

const defaultSelect=(name,material,rows,current)=>field(material,select(name,[['','No default'],...rows.map(row=>[row.id,row.label])],current??''));
const buildForm=(children,submit,label='Save changes')=>el('form',{class:'stack',autocomplete:'off',onsubmit:task(async event=>{
  event.preventDefault();
  await submit(elements(event.currentTarget));
})},children,el('div',{class:'actions'},el('button',{class:'button primary',type:'submit'},label)));
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
    const education=key==='education';
    const dateType=education?'month':'date';
    const end=input('end',historyDate(existing.end,key),{type:dateType});
    const endField=field(education?'End month':'End date',end);
    const currentField=check('current',education?'I currently study here':'I currently work in this role',existing.current===true);
    currentField.classList.add('wide');
    const current=currentField.querySelector('input');
    const sync=()=>{endField.hidden=current.checked;end.disabled=current.checked;};
    current.addEventListener('change',sync);
    sync();
    formDialog(index==null?'Add '+key:'Edit '+key,[el('div',{class:'form-grid'},workFields[key].map(([name,label],i)=>{
      if(name==='start') return [currentField,field(education?'Start month':label,input('start',historyDate(existing.start,key),{type:dateType}))];
      if(name==='end') return endField;
      const value=existing[name]??'';
      const control=name==='description'?textarea(name,value,{maxlength:12000}):input(name,value,{required:i===0});
      return field(label,control);
    }))],async values=>{
      values.current=values.current==='1';
      if(values.current) delete values.end;
      const current=(await settings()).profile[key]??[];
      if(index==null) current.push(values);else current[index]=values;
      await rpc('settings:update',{config:{profile:{[key]:current}}});toast('Profile history saved.');
    });
  })().catch(error=>toast(error.message,true));
}
const historyDate=(value,key)=>key==='education'?value?.slice(0,7):value;
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
      [historyDate(row.start,key)||'Unknown',row.current===true?'Present':historyDate(row.end,key)||'—'].join(' — '),
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
      items.length?el('ul',{class:'inset'},items.map(item=>el('li',{},
        el('div',{},el('strong',{},versionLabel(item)),paragraph(item.name,'meta')),
        el('div',{class:'actions'},button('Preview',()=>pdfPreview(item),'small'),button('Edit',()=>materialDialog(type,item),'small',{'aria-label':'Edit '+item.label}),button('Delete',()=>remove(item),'danger small'))
      ))):paragraph('No '+label.toLowerCase()+' PDFs yet.','meta'),
      items.length>0&&buildForm(defaultSelect(key,'Default '+label.toLowerCase(),items,config[key]),async values=>{
        await rpc('settings:update',{config:values});toast('Default document saved.');
      },'Save default'));
  });
}
function answerDialog(answer,preset) {
  const question=preset?.question??answer?.question??'';
  const value=answer?.value??'';
  let answerControl;
  if(preset?.countries) {
    answerControl=tokenField('countries','Answer',value,{choices:COUNTRY_OPTIONS,custom:false}).root;
  } else if(preset?.choices) {
    const options=value&&!preset.choices.includes(value)?[...preset.choices,value]:preset.choices;
    answerControl=field('Answer',select('value',[['','Choose an answer'],...options],value,{required:true}));
  } else {
    answerControl=field('Answer',textarea('value',value,{required:true,maxlength:6000}));
  }
  formDialog(answer?'Edit verified answer':'Add verified answer',[
    preset?el('p',{class:'answer-question'},question):field('Question',textarea('question',question,{required:true,maxlength:420})),
    answerControl
  ],async values=>{
    const response=preset?.countries?readTokens(values,'countries').join(', '):values.value;
    if(structuredValue(response))throw new Error('Enter a plain-text answer.');
    await saveAnswer({question:preset?question:values.question,value:response,id:answer?.id});
    toast('Answer saved.');
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
    el('div',{class:'actions'},button('Add custom answer',()=>answerDialog(),'small')),
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
const row=(label,control,help)=>el('li',{},el('div',{class:'label'},el('span',{},label),help&&el('small',{},help)),el('div',{class:'control'},control));
const toggle=(name,label,checked,help)=>{
  const box=input(name,'1',{type:'checkbox',checked,'aria-label':label});
  box.addEventListener('change',task(()=>rpc('settings:update',{config:{[name]:box.checked}}),'Saved.'));
  return row(label,box,help);
};
function jobSearch(config,{searchMode,discoveryPreferences}) {
  const access=el('span',{},'Checking…');
  void rpc('integrations:status').then(status=>access.replaceChildren(status.atsAccess?badge('Allowed','ok'):
    button('Allow',task(async()=>{await permit(ATS_ORIGINS);access.replaceChildren(badge('Allowed','ok'));}),'small'))).catch(()=>{});
  return el('ul',{class:'settings-list'},
    row('Discovery preferences',button('Edit',()=>discoveryPreferences(),'small')),
    row('Search status',button(config.mode,()=>searchMode(config),'small',{'aria-label':'Search '+config.mode.toLowerCase()}),'Pause or finish automatic checks and alerts.'),
    row('Job application sites',access,'Lets the Side Panel follow Greenhouse, Ashby, Lever, Workday, SmartRecruiters and Workable pages.'),
    toggle('directAlerts','New job notifications',config.directAlerts));
}
function claude(config,usage) {
  const status=el('span',{});
  const refresh=async()=>{const data=await rpc('integrations:status');status.replaceChildren(data.claude?badge('Connected','ok'):badge('Not connected'));};
  void refresh().catch(()=>{});
  const month=new Date().toLocaleDateString('en-CA',{year:'numeric',month:'2-digit'});
  const spent=usage.filter(item=>item.month===month).reduce((total,item)=>total+item.cost,0);
  const key=()=>formDialog('Claude API key',[
    field('API key',input('key','',{type:'password',autocomplete:'off',required:true})),
    paragraph('Stored locally in this Chrome profile, unencrypted. Requests send only relevant excerpts to Anthropic.')
  ],async ({key})=>{await permit(['https://api.anthropic.com/*']);await rpc('secret:claude',{key});await refresh();toast('Claude connected.');},'Connect');
  const budget=input('budget',config.budget,{type:'number',min:0,max:10000,step:'1','aria-label':'Monthly budget in USD'});
  budget.addEventListener('change',task(()=>rpc('settings:update',{config:{budget:Number(budget.value)}}),'Budget saved.'));
  const models=Object.keys(PRICES);
  const model=select('model',models,config.model,{'aria-label':'Model'});
  model.addEventListener('change',task(()=>rpc('settings:update',{config:{model:model.value,draftModel:model.value}}),'Model saved.'));
  return [el('ul',{class:'settings-list'},
    row('Claude',el('span',{class:'actions'},status,button('Set key',key,'small'),button('Clear',task(async()=>{await rpc('secret:claude',{key:''});await refresh();}),'quiet small'))),
    row('Monthly budget · USD',budget,'Spent this month '+money(spent)+'. Estimates can differ from provider billing.'),
    toggle('autoMatch','Match new jobs',config.autoMatch,'Scores new matching jobs against your profile.'),
    toggle('dailySearch','Daily web search',config.dailySearch,'Looks for new employers once a day.')),
    el('details',{class:'more'},el('summary',{},'Advanced'),el('ul',{class:'settings-list'},row('Model',model,'Pricing checked '+PRICE_VERSION+'.')))];
}
function copyable(value,label) {
  return el('span',{class:'actions'},el('code',{class:'copy'},value),button('Copy',task(async()=>{await navigator.clipboard.writeText(value);},'Copied.'),'quiet small',{'aria-label':'Copy '+label}));
}
// Any Google account works; if the build ships no OAuth client, the user adds their own once (no rebuild).
const SETUP={
  gmail:{label:'Gmail',idLabel:'Client ID',placeholder:'1234-abc.apps.googleusercontent.com',steps:redirect=>[
    el('li',{},link('Enable the Gmail API','https://console.cloud.google.com/apis/library/gmail.googleapis.com'),' (create a project if asked).'),
    el('li',{},link('Open Google Auth Platform','https://console.cloud.google.com/auth/overview'),': Get started, any app name, your email, audience External. Then Audience → Publish app. The “unverified app” notice is normal for your own app.'),
    el('li',{},link('Create an OAuth client','https://console.cloud.google.com/auth/clients/create'),': type Web application, add this authorized redirect URI:',copyable(redirect,'redirect URI')),
    el('li',{},'Paste the Client ID below.')]},
  outlook:{label:'Outlook',idLabel:'Application (client) ID',placeholder:'00000000-0000-0000-0000-000000000000',steps:redirect=>[
    el('li',{},link('Register an app','https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/CreateApplicationBlade'),': any name; account types “any organization and personal Microsoft accounts”; redirect URI platform Web:',copyable(redirect,'redirect URI')),
    el('li',{},'In Authentication, tick Access tokens under Implicit grant and save.'),
    el('li',{},'Paste the Application (client) ID below.')]}
};
// Each user connects their own mailbox with their own app: no shared client, no user cap, any account.
function mailSetup(provider,status,after) {
  const spec=SETUP[provider];
  formDialog('Connect '+spec.label,[
    paragraph('One-time setup, about five minutes. Your app is yours alone; MeshJob only reads mail.'),
    el('ol',{class:'steps'},spec.steps(status.mailRedirect)),
    field(spec.idLabel,input('clientId',status.clients[provider],{required:true,placeholder:spec.placeholder}))
  ],async ({clientId})=>{
    await rpc('mail:client',{provider,clientId});
    await connectMail(provider);after?.();
  },'Save and connect');
}
async function connectMail(provider) {
  await permit(MAIL_PROVIDERS[provider].origins,['identity']);
  const {account}=await rpc('mail:connect',{provider});
  toast((account||MAIL_PROVIDERS[provider].label)+' connected. MeshJob reads recruiting mail only.');
}
export function addMailDialog() {
  const file=input('eml','',{type:'file',accept:'.eml,message/rfc822,text/plain'});
  formDialog('Add an email',[
    paragraph('For any mailbox: paste the subject and text of a recruiting email, or choose a saved .eml file.'),
    field('Email',textarea('text','',{rows:8,placeholder:'Subject: Interview invitation\n\nHi …'})),field('Or a saved email file',file)
  ],async values=>{
    const text=file.files[0]?await file.files[0].text():values.text;
    const result=await rpc('mail:add',{text});
    toast(result.duplicate?'This email was already added.':[result.category&&result.category!=='unknown'?result.category:'Email added',
      result.linked?'linked to '+result.linked:'review it in Needs attention',result.urgent&&'action required'].filter(Boolean).join(' · '));
  },'Add email');
}
function email(config,health) {
  const status=el('span',{class:'actions'});
  const help=el('small',{});
  const advanced=el('ul',{class:'settings-list'});
  const start=(provider,data)=>task(async()=>{data.clients[provider]?await connectMail(provider):mailSetup(provider,data,refresh);void refresh();});
  const refresh=async()=>{
    const data=await rpc('integrations:status');
    const current=MAIL_PROVIDERS[config.mailProvider]?.label??'Gmail';
    help.textContent=config.gmail?current+' · '+(data.mailAccount||'connected')+' · reads mail since '+dateLabel(config.gmailSince)+' · '+
      (health?.successAt?'last sync '+dateLabel(health.successAt):'waiting for first sync')+(health?.error?' · '+health.error:''):
      'Read-only. Any account. Only mail received after you connect is read.';
    status.replaceChildren(...(config.gmail?[badge('Connected','ok'),button('Switch account',start(config.mailProvider,data),'quiet small')]:
      ['gmail','outlook'].map(provider=>button('Connect '+MAIL_PROVIDERS[provider].label,start(provider,data),provider==='gmail'?'primary small':'small'))));
    advanced.replaceChildren(...['gmail','outlook'].map(provider=>el('li',{},
      el('div',{class:'label'},el('span',{},MAIL_PROVIDERS[provider].label+' app'),el('small',{},data.clients[provider]||'Not set up')),
      el('div',{class:'control'},button(data.clients[provider]?'Change':'Set up',()=>mailSetup(provider,data,refresh),'small'),
        data.clients[provider]&&button('Remove',task(async()=>{await rpc('mail:client',{provider,clientId:''});await refresh();},'Removed.'),'quiet small')))),
      el('li',{},el('div',{class:'label'},el('span',{},'Redirect URI')),el('div',{class:'control'},copyable(data.mailRedirect,'redirect URI'))));
  };
  void refresh().catch(()=>{});
  return [el('ul',{class:'settings-list'},
    el('li',{},el('div',{class:'label'},el('span',{},'Email'),help),el('div',{class:'control'},status)),
    config.gmail&&row('Sync',el('span',{class:'actions'},button('Sync now',()=>operation('Sync email','gmail:sync'),'small'),
      button('Disconnect',()=>formDialog('Disconnect email',[paragraph('Recorded events stay.'),config.mailProvider==='gmail'&&check('revoke','Also revoke Google access')],
        async values=>{await rpc('mail:disconnect',{revoke:!!values.revoke});toast('Email disconnected.');},'Disconnect'),'quiet small'))),
    row('Other email',button('Add email',addMailDialog,'small'),'Yahoo, iCloud, QQ, 163 and others: forward recruiting mail to your connected Gmail or Outlook, or add a message here.'),
    row('Notifications',button('Send test',task(()=>rpc('notification:test'),'Test notification sent.'),'small'))),
    el('details',{class:'more'},el('summary',{},'Advanced'),advanced)];
}
function registrationEmail(config) {
  const value=input('registrationEmail','',{type:'email',placeholder:config.profile.email||'name@example.com','aria-label':'Registration email',maxlength:254});
  void rpc('integrations:status').then(data=>{value.value=data.registrationEmail;}).catch(()=>{});
  value.addEventListener('change',task(()=>rpc('secret:registration',{email:value.value}),'Registration email saved.'));
  return el('ul',{class:'settings-list'},row('Registration email',value,'Used on ATS sign-up forms. Chrome Password Manager handles passwords.'));
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
    estimate,el('div',{class:'actions'},button('Download backup ZIP',task(backup),'primary'),button('Import backup ZIP',restoreDialog),button('Storage details',storageHelp),
      button('Clear all MeshJob data',()=>formDialog('Clear local MeshJob data',[
        paragraph('This permanently removes MeshJob records and local credentials on this device. You can export a backup first.'),
        button('Download a backup',task(backup)),field('Type DELETE to confirm',input('confirm','',{required:true,pattern:'DELETE'}))
      ],async values=>{await rpc('data:clear',{confirm:values.confirm});toast('Local MeshJob data cleared.');},'Permanently delete'),'danger'))
  ];
}
export function profileView({config,materials,answers,health,usage},controls) {
  const parts=[
    ['Profile',[factsForm(config),profileHistory(config.profile,'education'),profileHistory(config.profile,'experience'),skillsForm(config.profile)]],
    ['Documents',documentsView(config,materials)],
    ['Answers',answersView(answers)],
    ['Job search',jobSearch(config,controls)],
    ['Claude',claude(config,usage)],
    ['Email',email(config,health)],
    ['Registration',registrationEmail(config)],
    ['Data',localData(controls)]
  ];
  return el('div',{class:'stack large'},el('header',{class:'page-head'},el('h1',{},'Settings')),
    parts.map(([label,content])=>el('section',{class:'section'},el('h2',{},label),el('div',{class:'stack'},content))));
}
