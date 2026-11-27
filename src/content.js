import { canonicalUrl, distinctValues, httpUrl, JOB_DESCRIPTION_LIMIT, normalized, trim, workdayEmployer, workdayTenant } from './domain.js';
import { consentField, criticalField, fieldKey, greenhouseEmbed, receiptSignature, RECEIPT_SELECTORS, registrationEmailField } from './form-rules.js';

(() => {
  if (globalThis.meshJobContentInstalled) return;
  globalThis.meshJobContentInstalled = true;
  const win = window;
  const doc = document;
  let fields = new Map();
  let revision;
  let formContext;
  let busy = false;
  let cancelled = false;
  let intent = false;
  let receiptTimer;
  let lastReceipt;
  const expectedUrl = () => location.href;
  const names = new WeakMap();
  let counter = 0;
  const selector = 'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]),textarea,select,[role="combobox"]:not(input),[role="checkbox"],[role="radio"],[contenteditable="true"]';
  const first = (...selectors) => selectors.map(s=>doc.querySelector(s)).find(Boolean);
  const visible = node => {
    if (!node || node.closest('[hidden],[inert],[aria-hidden="true"]')) return false;
    const style = getComputedStyle(node);
    return style.visibility!=='hidden' && style.display!=='none' && !!node.getClientRects().length;
  };
  const visibleFields = () => [...doc.querySelectorAll(selector)].filter(node=>visible(node) ||
    node.type==='file' && [...(node.labels??[])].some(visible));
  function fieldId(node) {
    if(!names.has(node)) names.set(node,'field-'+(++counter));
    return names.get(node);
  }
  const providerOf = () => {
    const host = location.hostname;
    if (/(^|\.)greenhouse\.io$/.test(host)) return 'greenhouse';
    if (/(^|\.)ashbyhq\.com$/.test(host)) return 'ashby';
    if (/(^|\.)lever\.co$/.test(host)) return 'lever';
    if (/(^|\.)(?:myworkdayjobs|myworkdaysite)\.com$/.test(host)) return 'workday';
    return 'generic';
  };
  function embeddedForm() {
    const matches=[...doc.querySelectorAll('iframe[src]')].filter(visible)
      .map(node=>greenhouseEmbed(node.src)).filter(Boolean);
    return matches.length===1?matches[0]:null;
  }
  function databricksJob() {
    if(!['databricks.com','www.databricks.com'].includes(location.hostname) ||
       !/^\/company\/careers\/[^/]+\/[^/]+-\d+\/?$/.test(location.pathname)) return {};
    const locationLine=first('main h1','h1')?.nextElementSibling;
    const description=first('.rich-text-body');
    const requisition=[...description?.querySelectorAll(':scope > p')??[]].slice(0,4)
      .map(node=>trim(node.textContent)).find(value=>/^[A-Z]{2,6}\d{2,}R\d{2,}$/.test(value));
    return {company:'Databricks',location:trim([...locationLine?.childNodes??[]].find(node=>node.nodeType===Node.TEXT_NODE&&trim(node.textContent))?.textContent),
      requisition,jd:visible(description)?description.innerText.trim().slice(0,JOB_DESCRIPTION_LIMIT):''};
  }
  function readJob() {
    let posting;
    function find(value) {
      if (Array.isArray(value)) return value.map(find).find(Boolean);
      if (!value || typeof value!=='object') return null;
      if ([value['@type']].flat().includes('JobPosting')) return value;
      return find(value['@graph']);
    }
    for (const tag of doc.querySelectorAll('script[type="application/ld+json"]')) {
      try { posting ||= find(JSON.parse(tag.textContent)); } catch { /* External markup. */ }
    }
    const provider = providerOf();
    const custom=databricksJob();
    const host = location.hostname;
    const segments = location.pathname.split('/').filter(Boolean);
    const metaTitle=first('meta[property="og:title"]')?.content;
    const mongoListing=['mongodb.com','www.mongodb.com'].includes(host)&&/^\/careers\/jobs\/\d+\/?$/.test(location.pathname);
    const title = posting?.title || (mongoListing&&metaTitle) ||
      first('[data-automation-id="jobPostingHeader"]','h1.app-title','.posting-headline h2','.section-wrapper h2','main h1','h1','h2')?.textContent || metaTitle || doc.title || '';
    const siteName = first('meta[property="og:site_name"]')?.content;
    const tenant = workdayTenant(host);
    const logoName = provider==='workday' ? first('[data-automation-id="logoLink"] img[alt]')?.alt.replace(/\s+search for jobs$/i,'') : '';
    const company = provider==='workday' ? [posting?.hiringOrganization?.name,siteName,workdayEmployer(host),logoName].map(trim)
      .find(name=>name && normalized(name)!==normalized(tenant) && !/^(?:workday|logo|careers|search for jobs)$/i.test(name)) :
      posting?.hiringOrganization?.name || custom.company || siteName || (provider!=='generic'?segments[0]:'');
    const descriptionHtml = typeof posting?.description==='string' ? posting.description.slice(0,300_000) : '';
    const description = first('[data-automation-id="jobPostingDescription"]');
    const jd = provider==='workday' && visible(description) ? description.innerText.trim().slice(0,JOB_DESCRIPTION_LIMIT) : custom.jd??'';
    return {
      url:canonicalUrl(expectedUrl()),provider,title:trim(title).slice(0,240),company:trim(company).slice(0,160),
      requisition:trim(posting?.identifier?.value || first('[data-automation-id="jobReqId"]')?.textContent || custom.requisition).slice(0,120),
      location:trim(posting?.jobLocation?.address?.addressLocality || first('.location','[data-automation-id="locations"]')?.textContent || custom.location || (mongoListing&&first('h1 h3')?.textContent)).slice(0,240),
      attribution:host,jd,descriptionHtml
    };
  }
  function groupOf(node) {
    const group = node.closest('[data-automation-id^="workExperience-"],[data-automation-id^="education-"],[data-meshjob-row]');
    if (!group) return null;
    const marker = group.dataset.automationId ?? group.dataset.meshjobRow;
    const match = /^(workExperience|experience|education)[-_]?(\d+)$/i.exec(marker);
    return match ? {kind:match[1].toLowerCase()==='education'?'education':'experience',index:Number(match[2])-(group.dataset.meshjobRow?0:1)} : null;
  }
  function nativeLabel(node) {
    const aria = node.getAttribute('aria-labelledby')?.split(/\s+/).map(id=>doc.getElementById(id)?.textContent).join(' ');
    const labels = [...(node.labels ?? [])].map(el=>el.textContent).join(' ');
    const parent = node.closest('[data-automation-id^="formField-"],[role="group"]');
    const nearby = parent?.querySelector('label,[data-automation-id="formLabel"]')?.textContent;
    return trim(aria || node.getAttribute('aria-label') || labels || nearby || node.getAttribute('placeholder') || node.getAttribute('title') || node.name || node.id).slice(0,420);
  }
  function regionForRadio(node) {
    return node.closest('fieldset,[role="radiogroup"],[data-automation-id^="formField-"]') ?? node.parentElement;
  }
  function optionsOf(node,type) {
    if (type==='select') return [...node.options].filter(option=>!option.disabled && option.value).map(option=>trim(option.textContent));
    if (type==='radio') return radioNodes(node).map(nativeLabel);
    return [];
  }
  function radioNodes(node) {
    if (node.getAttribute('role')==='radio') return [...regionForRadio(node).querySelectorAll('[role="radio"]')].filter(visible);
    const name = node.name;
    if (!name) return [node];
    return [...(node.form??doc).querySelectorAll('input[type=radio][name="'+CSS.escape(name)+'"]')].filter(visible);
  }
  function skillPicker(node) {
    if(providerOf()!=='workday'||!(node instanceof HTMLInputElement)||!['text','search'].includes(node.type)) return null;
    const section=node.closest('[data-automation-id="skillsSection"],[data-automation-id="formField-skills"],[data-automation-id="skills"]');
    if(!section) return null;
    return node.closest('[data-automation-id="multiSelectContainer"]')??section;
  }
  function selectedSkills(widget) {
    const tokens=widget?.querySelectorAll('[data-selected-skill],[data-automation-id="selectedItem"],[data-automation-id="selectedItemLabel"],[data-automation-id="selectedItemText"],[data-automation-id="multiSelectValue"]')??[];
    return [...tokens].map(item=>trim(item.getAttribute('data-selected-skill')||item.querySelector('[data-automation-id="selectedItemLabel"]')?.textContent||item.textContent));
  }
  function valueExists(node,type) {
    if (type==='skill-picker') return selectedSkills(skillPicker(node)).length>0;
    if (type==='radio') return radioNodes(node).some(input=>input.checked || input.getAttribute('aria-checked')==='true');
    if (type==='checkbox') return node.checked || node.getAttribute('aria-checked')==='true';
    if (type==='file') return !!node.files?.length;
    if (node.isContentEditable) return !!trim(node.textContent);
    if (node.tagName==='BUTTON') return !!node.getAttribute('data-selected-value') ||
      !!trim(node.textContent) && !/^(?:select|choose|please select|pick|search)(?:\b|…)/i.test(trim(node.textContent));
    if (type==='select') return !!node.value && !/^(?:select|choose|please select|pick)(?:\b|…)/i.test(trim(node.selectedOptions?.[0]?.textContent));
    return !!trim(node.value);
  }
  function scan() {
    fields = new Map();
    const result = [];
    const grouped = new Set();
    for (const node of visibleFields()) {
      const role = node.getAttribute('role');
      const type = skillPicker(node)?'skill-picker':['radio','checkbox','combobox'].includes(role)?role:
        node.tagName==='SELECT'?'select':node.tagName==='TEXTAREA'||node.isContentEditable?'textarea':node.type || 'text';
      let label = type==='skill-picker'?'Skills':nativeLabel(node);
      let radioOptions = [];
      if (type==='radio') {
        radioOptions = radioNodes(node);
        const first = radioOptions[0] ?? node;
        if (grouped.has(first)) continue;
        grouped.add(first);
        const region = regionForRadio(node);
        label = trim(region.querySelector(':scope > legend,:scope > label,[data-automation-id="formLabel"]')?.textContent ||
          region.getAttribute('aria-label') || (region.getAttribute('aria-labelledby') && doc.getElementById(region.getAttribute('aria-labelledby'))?.textContent) || node.name || label);
      }
      const id = fieldId(node);
      const name = node.name || node.getAttribute('data-automation-id') || node.id;
      const phrase = label+' '+name+' '+(type==='checkbox' ? trim(node.parentElement?.textContent).slice(0,250) : '');
      const row = {
        id,label,name,type,multiple:node.multiple===true,partial:type==='skill-picker'&&!!trim(node.value),group:groupOf(node),autocomplete:node.getAttribute('autocomplete')?.split(/\s+/).at(-1),
        required:node.required || node.getAttribute('aria-required')==='true' || node.closest('[data-required="true"]')!==null ||
          radioOptions.some(current=>current.required) || /\*$/.test(label),
        critical:criticalField(phrase),consent:consentField(phrase),
        disabled:node.matches(':disabled,[aria-disabled="true"],[readonly]'),filled:valueExists(node,type),
        options:optionsOf(node,type).slice(0,180)
      };
      fields.set(id,{row,node});
      result.push(row);
    }
    return result.slice(0,200);
  }
  const waitingFor = (read,ms=1100) => new Promise(resolve=>{
    const immediate = read();
    if (immediate) {resolve(immediate);return;}
    const observer = new MutationObserver(()=>{const value=read();if(value) stop(value);});
    const timer = setTimeout(()=>stop(read()),ms);
    function stop(value){observer.disconnect();clearTimeout(timer);resolve(value);}
    observer.observe(doc.documentElement,{childList:true,characterData:true,subtree:true,attributes:true});
  });
  const safeClick = node => {
    if (!node || !visible(node) || node.closest('a') || node.matches(':disabled,[aria-disabled="true"],[type="submit"],[formaction]')) return false;
    if (node.tagName==='BUTTON' && node.form && node.type!=='button') return false;
    node.click();
    return true;
  };
  function dispatch(node) {
    node.dispatchEvent(new Event('input',{bubbles:true,composed:true}));
    node.dispatchEvent(new Event('change',{bubbles:true}));
    node.dispatchEvent(new FocusEvent('focusout',{bubbles:true,composed:true}));
  }
  function setNative(node,value,property='value',complete=true) {
    let parent = Object.getPrototypeOf(node);
    while (parent) {
      const propertySet = Object.getOwnPropertyDescriptor(parent,property)?.set;
      if (propertySet) {
        propertySet.call(node,value);
        if(complete)dispatch(node);else node.dispatchEvent(new Event('input',{bubbles:true,composed:true}));
        return;
      }
      parent = Object.getPrototypeOf(parent);
    }
    throw new Error('Unsupported form control.');
  }
  function choose(nodes,value,label) {
    const wanted = normalized(value);
    const same = nodes.filter(node=>normalized(label(node))===wanted);
    if (same.length===1) return same[0];
    const aliases = {usa:['united states','united states of america','us'],us:['united states','united states of america','usa'],
      uk:['united kingdom','great britain','gb'],gb:['united kingdom','great britain','uk']};
    const found = nodes.filter(node=>(aliases[wanted]??[]).includes(normalized(label(node))));
    return found.length===1 ? found[0] : null;
  }
  function decode(encoded) {
    return Uint8Array.from(atob(encoded),part=>part.charCodeAt(0));
  }
  async function fillSkills(node,skills) {
    const widget=skillPicker(node);
    if(!widget||node.value||!skills?.length) throw new Error('Finish editing this skills field manually.');
    const isSelected=skill=>selectedSkills(widget).some(value=>value.toLowerCase()===skill.toLowerCase());
    const popup=()=>{
      const id=node.getAttribute('aria-controls')||node.getAttribute('aria-owns');
      return id?doc.getElementById(id):widget.querySelector('[role=listbox],[data-automation-id="promptOptions"]');
    };
    const deadline=performance.now()+8000;
    for(const skill of skills) {
      if(cancelled||performance.now()>deadline||!node.isConnected||node.value) break;
      if(isSelected(skill)) continue;
      node.focus();
      setNative(node,skill,'value',false);
      const choice=await waitingFor(()=>{
        const exact=[...popup()?.querySelectorAll('[role=option],[data-automation-id="promptOption"]')??[]]
          .filter(item=>visible(item)&&trim(item.textContent).toLowerCase()===skill.toLowerCase());
        return exact.length===1?exact[0]:null;
      },500);
      if(cancelled||!node.isConnected) break;
      if(choice&&safeClick(choice)) await waitingFor(()=>isSelected(skill),300);
      if(node.value===skill) setNative(node,'','value',false);
    }
    if(skills.some(skill=>!isSelected(skill))) throw new Error('Review remaining skills. MeshJob selected exact options it could verify.');
    return ()=>skills.every(isSelected);
  }
  async function setField(node,row,entry) {
    const value = entry.value;
    if (row.type==='skill-picker') return fillSkills(node,entry.skills);
    if (row.type==='file') {
      const {name,data} = entry.file ?? {};
      if (!name || !data || !/\.pdf$/i.test(name)) throw new Error('Choose a PDF in the side panel.');
      if (node.accept && !node.accept.split(',').some(value=>['.pdf','application/pdf','application/*','*/*'].includes(value.trim().toLowerCase()))) throw new Error('This control does not list PDF support.');
      const transfer = new DataTransfer();
      transfer.items.add(new File([decode(data)],name,{type:'application/pdf'}));
      setNative(node,transfer.files,'files');
      return () => node.files?.[0]?.name === name || trim(node.closest('[data-automation-id^="formField-"],.field,.application-question')?.textContent).includes(name);
    }
    if (row.type==='checkbox') {
      const desired = /^(true|yes|checked)$/i.test(value);
      if (!/^(true|yes|checked|false|no|unchecked)$/i.test(value)) throw new Error('Saved answer does not match the checkbox.');
      if (node.matches('input[type=checkbox]')) setNative(node,desired,'checked');
      else if (valueExists(node,row.type)!==desired && !safeClick(node)) throw new Error('Choose this checkbox manually.');
      return () => valueExists(node,row.type)===desired;
    }
    if (row.type==='radio') {
      const arm = choose(radioNodes(node),value,nativeLabel);
      if (!arm) throw new Error('Saved answer does not match an available option.');
      if (arm.matches('input[type=radio]')) setNative(arm,true,'checked');
      else if (!safeClick(arm)) throw new Error('Select this option manually.');
      return () => !!arm.checked || arm.getAttribute('aria-checked')==='true';
    }
    if (row.type==='select' && row.multiple) {
      const options=[...node.options].filter(item=>!item.disabled&&item.value);
      const matches=choose(options,value,item=>item.textContent);
      const requested=matches?[matches]:(entry.skills??distinctValues(value)).map(word=>choose(options,word,item=>item.textContent));
      if(!requested.length||requested.some(option=>!option)) throw new Error('One or more saved choices are unavailable.');
      for(const option of requested) option.selected=true;
      dispatch(node);
      return ()=>requested.every(option=>option.selected);
    }
    if (row.type==='select') {
      const read = () => choose([...node.options].filter(item=>!item.disabled&&item.value),value,item=>item.textContent);
      const option = read() ?? (['region','city'].includes(fieldKey(row)) ? await waitingFor(read,500) : null);
      if (!option || cancelled) throw new Error('No exact matching option.');
      setNative(node,option.value);
      return ()=>node.value===option.value;
    }
    if (row.type==='combobox') {
      if (!safeClick(node)) throw new Error('Select this option manually.');
      const popup = () => {
        const controls = node.getAttribute('aria-controls') || node.getAttribute('aria-owns');
        const id = node.getAttribute('id');
        return (controls && doc.getElementById(controls)) || (id && doc.querySelector('[role="listbox"][aria-labelledby="'+CSS.escape(id)+'"]'));
      };
      if (!await waitingFor(popup,350)) throw new Error('No accessible options are tied to this control.');
      const findOption = ()=>choose([...popup()?.querySelectorAll('[role="option"]')??[]].filter(visible),value,item=>item.textContent);
      let option = findOption();
      const typed = !option&&node.tagName==='INPUT'&&!node.readOnly&&!node.value;
      if (typed) setNative(node,value);
      option ??= await waitingFor(findOption,750);
      if (!option || cancelled || !safeClick(option)) {
        if (typed && node.isConnected && node.value===String(value)) setNative(node,'');
        throw new Error('No exact accessible option.');
      }
      return ()=>normalized(node.value || node.textContent)===normalized(value) || option.getAttribute('aria-selected')==='true' ||
        normalized(node.parentElement?.querySelector('[data-selected-value], [class*="singleValue"]')?.textContent)===normalized(value);
    }
    if (node.isContentEditable) {node.textContent=value;dispatch(node);}
    else setNative(node,value);
    return ()=>String(node.isContentEditable ? node.textContent : node.value)===String(value);
  }
  function getStep() {
    return trim(first('[data-automation-id="pageHeaderTitle"]','[data-automation-id="adventureTitle"]','main h1')?.textContent);
  }
  function hasChallenge() {
    return [...doc.querySelectorAll('iframe[src*="captcha"],[data-captcha-challenge],#cf-challenge-running')].some(node=>{
      if(!visible(node)) return false;
      if(!(node instanceof HTMLIFrameElement)) return true;
      const url=httpUrl(node.src);
      const badge=url && node.closest('.grecaptcha-badge') &&
        ['www.google.com','www.recaptcha.net','recaptcha.net'].includes(url.hostname) &&
        /^\/recaptcha\/(?:api2|enterprise)\/anchor$/.test(url.pathname) && url.searchParams.get('size')==='invisible';
      return !badge;
    });
  }
  function blockers() {
    const provider = providerOf();
    const page = normalized(getStep());
    const challenge = hasChallenge();
    const password = [...doc.querySelectorAll('input[type=password]')].some(visible);
    const registration = password && provider!=='generic' && /\b(?:create account|create an account|registration|register|sign up)\b/.test(page) &&
      !/\b(?:login|sign in to|log in|reset)\b/.test(page);
    return {challenge,login:password&&!registration,registration};
  }
  function receipt() {
    const provider = providerOf();
    const marker = RECEIPT_SELECTORS[provider]?.find(selector=>visible(doc.querySelector(selector)));
    if (!marker) return null;
    const root=doc.querySelector(marker);
    const finalVisible=[...doc.querySelectorAll('button[type=submit],input[type=submit]')].some(node=>visible(node)&&/submit application/i.test(node.innerText || node.value));
    const signature=receiptSignature({provider,marker,text:trim(root.textContent),finalVisible});
    return signature ? {provider,signature} : null;
  }
  function validationErrors() {
    return [...doc.querySelectorAll('[aria-invalid="true"],[data-automation-id="errorMessage"],.field-error')].filter(visible);
  }
  async function fill(message) {
    if (busy) throw new Error('Another fill operation is in progress.');
    const state = blockers();
    if (state.challenge || state.login) throw new Error('Complete the login or challenge in the page before filling.');
    if (message.url!==expectedUrl() || message.revision!==revision) throw new Error('The form changed. Scan the page again.');
    busy=true;
    cancelled=false;
    const start = performance.now();
    const results=[];
    try {
      const priority=entry=>['country','phoneCountry'].includes(fieldKey(fields.get(entry.id)?.row??{})) ? -1 : 0;
      for (const entry of message.plan.slice(0,200).sort((a,b)=>priority(a)-priority(b))) {
        if (cancelled || expectedUrl()!==message.url || message.revision!==revision || hasChallenge()) break;
        const handle = fields.get(entry.id);
        if (!handle || !handle.node.isConnected || handle.node.matches(':disabled,[aria-disabled=true],[readonly]')) continue;
        const {node,row} = handle;
        if (row.disabled || row.consent || row.type==='password'||(row.critical&&entry.authority!=='verified')) continue;
        if (row.type!=='skill-picker' && valueExists(node,row.type)) {results.push({id:row.id,label:row.label,state:'preserved'});continue;}
        try {
          const verify = await setField(node,row,entry);
          await Promise.resolve();
          const passing = verify() && node.validity?.valid!==false && node.getAttribute('aria-invalid')!=='true';
          results.push({id:row.id,label:row.label,state:passing?'filled':'failed',file:passing?entry.file?.name:undefined,
            materialText:passing&&entry.authority==='reviewed'&&row.type==='textarea',error:passing?undefined:'The page did not retain or accept the value.'});
        } catch(error) {results.push({id:row.id,label:row.label,state:'failed',error:error.message});}
      }
      const parsed = scan();
      const unresolved = parsed.filter(row=>row.required&&!row.disabled&&!row.filled);
      return {results,fields:parsed,unresolved,errors:validationErrors().length,duration:performance.now()-start,cancelled,challenge:hasChallenge()};
    } finally {busy=false;}
  }
  async function advance(message) {
    if (busy) throw new Error('Wait for the current form operation.');
    if (message.url!==expectedUrl() || message.revision!==revision || providerOf()!=='workday') throw new Error('This step must be advanced manually.');
    const state = blockers();
    const step = normalized(getStep());
    if (!/^(?:my information|my experience|application questions|additional questions|voluntary disclosures|self identification)$/.test(step) ||
      state.login || state.challenge || state.registration || validationErrors().length ||
      scan().some(field=>!field.disabled && ((field.required&&!field.filled)||field.consent||(field.critical&&!field.filled)))) throw new Error('Review this step in the page before continuing.');
    const next = doc.querySelector('button[data-automation-id="bottom-navigation-next-button"],button[data-automation-id="continueButton"]');
    if (!next || !/^(?:save and continue|next|continue)$/i.test(trim(next.textContent))) throw new Error('A recognizable non-final navigation button was not found.');
    if ([...doc.querySelectorAll('button,input[type=submit]')].some(node=>visible(node)&&/^(?:submit|submit application|finish application|create account|apply now)$/i.test(trim(node.innerText || node.value)))) throw new Error('The page contains a final submission control.');
    busy=true;
    try {
      if (!safeClick(next)) throw new Error('Advance using the employer page.');
      await waitingFor(()=>normalized(getStep())!==step || validationErrors().length,1700);
      return {step:getStep(),changed:normalized(getStep())!==step,errors:validationErrors().length};
    } finally {busy=false;}
  }
  async function prepareRows(message) {
    if (busy || message.url!==expectedUrl() || message.revision!==revision || providerOf()!=='workday' || normalized(getStep())!=='my experience' || blockers().challenge) throw new Error('Experience rows must be edited on the current Workday experience step.');
    busy=true;
    cancelled=false;
    try {
      for (const kind of ['experience','education']) {
        const desired = Math.min(12,message.counts[kind]??0);
        const sections = kind==='experience'?'[data-automation-id="workExperienceSection"]':'[data-automation-id="educationSection"]';
        const count = () => new Set(scan().filter(row=>row.group?.kind===kind).map(row=>row.group.index)).size;
        for (let current=count();current<desired;current=count()) {
          if (cancelled || expectedUrl()!==message.url || message.revision!==revision) break;
          const button=doc.querySelector(sections+' button[data-automation-id="add-button"],'+sections+' button[data-automation-id="addButton"]');
          if (!button||!/^add(?: another)?(?: (?:experience|education|job))?$/i.test(trim(button.textContent))||!safeClick(button)) break;
          if (!await waitingFor(()=>count()>current,850)) break;
        }
      }
      return scan();
    } finally {busy=false;}
  }
  function fillRegistration(message) {
    if (busy || message.url!==expectedUrl() || message.revision!==revision || !blockers().registration || blockers().challenge ||
      location.protocol!=='https:' || !/^(?:ashby|greenhouse|lever|workday)$/.test(providerOf())) throw new Error('Open a verified registration form before filling credentials.');
    const passwords=[...doc.querySelectorAll('input[type=password]')].filter(visible);
    const form=passwords[0]?.form;
    if(!passwords.length||passwords.length>2||passwords.some(node=>node.form!==form)) {
      throw new Error('Use the browser password manager on this form.');
    }
    const emails=visibleFields().filter(node=>node instanceof HTMLInputElement&&node.form===form&&
      registrationEmailField({type:node.type,label:nativeLabel(node),name:node.name,autocomplete:node.autocomplete}));
    const {email,value}=message;
    if(emails.length>2) throw new Error('Use the browser password manager on this form.');
    if(email&&value&&emails.some(node=>node.value&&node.value.toLowerCase()!==email.toLowerCase())) {
      throw new Error('The registration form has a different email. Review it before filling the saved password.');
    }
    const writable=node=>!node.value&&!node.matches(':disabled,[aria-disabled="true"],[readonly]');
    let count=0;
    for(const node of emails) {
      if(email&&writable(node)) {
        setNative(node,email);
        if(node.value===email) count++;
      }
    }
    if(value&&passwords.every(node=>(!node.value||node.value===value)&&/^(?:new-password)?$/.test(node.autocomplete)&&/\bpassword\b/i.test(nativeLabel(node)))) {
      for(const node of passwords) {
        if(!node.isConnected||!visible(node)||!writable(node)) continue;
        setNative(node,value);
        if(node.value===value) count++;
      }
    }
    return {count};
  }
  function send(payload) { if(window!==window.top)return;void chrome.runtime.sendMessage({...payload,page:expectedUrl()}).catch(()=>{}); }
  function inspectReceipt() {
    const proof = receipt();
    if (proof && lastReceipt!==expectedUrl()+' '+proof.signature) {
      lastReceipt=expectedUrl()+' '+proof.signature;
      send({type:'page:receipt',proof});
    }
  }
  function afterChange() {
    clearTimeout(receiptTimer);
    receiptTimer=setTimeout(inspectReceipt,240);
  }
  let lastIntentAt=0;
  function recordIntent(node) {
    const label = normalized(node?.innerText || node?.value);
    if (!/^(?:submit(?: my| your| the)? application|submit|apply)$/.test(label) || Date.now()-lastIntentAt<150) return;
    lastIntentAt=Date.now();
    intent=true;
    send({type:'page:intent'});
    afterChange();
  }
  doc.addEventListener('submit',event=>{if(event.isTrusted)recordIntent(event.submitter);},true);
  doc.addEventListener('click',event=>{
    if (!event.isTrusted || providerOf()==='generic') return;
    const button=event.target.closest?.('button,[role="button"],input[type="submit"]');
    if (button&&/^submit(?: my| your| the)? application$/.test(normalized(button.innerText||button.value))) recordIntent(button);
  },true);
  const observer = new MutationObserver(afterChange);
  observer.observe(doc.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['data-automation-id','data-testid','aria-hidden']});
  afterChange();

  const views=new Set();
  let viewTimer, lastView;
  function viewStamp() {
    const heading=first('[data-automation-id="jobPostingHeader"]','main h1','h1','h2');
    const controls=visibleFields().slice(0,200).map(node=>[fieldId(node),nativeLabel(node),node.required,
      node.matches(':disabled,[aria-disabled=true],[readonly]'),node.checked,node.getAttribute('aria-checked'),
      node.value?true:!!node.files?.length,node.isContentEditable&&!!trim(node.textContent),
      node.type,node.getAttribute('aria-required'),node.getAttribute('autocomplete'),
      node.tagName==='SELECT'&&optionsOf(node,'select').slice(0,180)]);
    return JSON.stringify([expectedUrl(),doc.title,trim(heading?.textContent),getStep(),blockers(),receipt(),embeddedForm(),
      !!first('script[type="application/ld+json"],[data-automation-id="jobPostingDescription"]'),controls]);
  }
  function scheduleView() {
    if(!views.size||viewTimer) return;
    viewTimer=setTimeout(()=>{
      viewTimer=null;
      if(!views.size) return;
      const next=viewStamp();
      if(next===lastView) return;
      lastView=next;
      for(const port of views) port.postMessage({type:'page:changed'});
    },90);
  }
  const viewObserver=new MutationObserver(scheduleView);
  chrome.runtime.onConnect.addListener(port=>{
    if(port.name!=='meshjob:watch' || port.sender?.id!==chrome.runtime.id ||
      port.sender?.url?.split(/[?#]/,1)[0]!==chrome.runtime.getURL('panel.html')) return;
    views.add(port);
    viewObserver.observe(doc.documentElement,{subtree:true,childList:true,characterData:true,attributes:true,
      attributeFilter:['class','style','hidden','inert','aria-hidden','aria-required','aria-disabled','aria-label','aria-checked',
        'required','disabled','readonly','data-automation-id','data-testid','value','src','aria-labelledby','name','type']});
    scheduleView();
    port.onDisconnect.addListener(()=>{
      views.delete(port);
      if(!views.size) viewObserver.disconnect();
    });
  });
  doc.addEventListener('load',event=>{
    if(event.target instanceof HTMLIFrameElement && greenhouseEmbed(event.target.src)) {
      lastView=null;
      scheduleView();
    }
  },true);
  doc.addEventListener('input',scheduleView,true);
  doc.addEventListener('change',scheduleView,true);
  win.addEventListener('pageshow',scheduleView);
  win.addEventListener('popstate',scheduleView);
  win.addEventListener('hashchange',scheduleView);
  win.navigation?.addEventListener('currententrychange',scheduleView);
  chrome.runtime.onMessage.addListener((message,sender,respond)=>{
    if (sender.id!==chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL('')) || !message?.type?.startsWith('form:')) return false;
    const handle = async ()=>{
      if (message.type==='form:embedded') return {embedded:embeddedForm(),challenge:hasChallenge()};
      if (message.type==='form:inspect') {
        const rows=scan();
        const page=expectedUrl(), step=getStep();
        const context=JSON.stringify([page,step,rows.map(row=>[row.id,row.label,row.type,row.required,row.disabled,row.critical,row.consent])]);
        if(context!==formContext) {formContext=context;revision=crypto.randomUUID();}
        if(message.watch) lastView=viewStamp();
        return {job:window===window.top?readJob():null,page,revision,fields:rows,step,...blockers(),intent,receipt:receipt(),embedded:embeddedForm()};
      }
      if (message.type==='form:fill') return fill(message);
      if (message.type==='form:advance') return advance(message);
      if (message.type==='form:rows') return prepareRows(message);
      if (message.type==='form:registration') return fillRegistration(message);
      if (message.type==='form:cancel') {cancelled=true;return true;}
      throw new Error('Unknown form operation.');
    };
    void handle().then(value=>respond({ok:true,value}),error=>respond({ok:false,error:error.message}));
    return true;
  });
})();
