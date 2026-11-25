import { distinctValues, httpUrl, structuredValue } from './domain.js';

export function el(tag,attributes,...children) {
  const node=document.createElement(tag);
  for(const [key,value] of Object.entries(attributes??{})) {
    if(value==null||value===false) continue;
    if(key.startsWith('on')&&typeof value==='function') node.addEventListener(key.slice(2).toLowerCase(),value);
    else if(['value','checked','selected','disabled','required','multiple','open'].includes(key)) node[key]=value;
    else if(key==='class') node.className=value;
    else node.setAttribute(key,value===true?'':String(value));
  }
  for(const child of children.flat(Infinity)) {
    if(child==null||child===false) continue;
    node.append(child instanceof Node?child:document.createTextNode(String(child)));
  }
  return node;
}
export const button=(label,fn,style='',attributes={})=>el('button',{...attributes,type:'button',class:('button '+style).trim(),onclick:fn},label);
export function link(label,url,style='text-link') {
  return httpUrl(url)?el('a',{href:url,target:'_blank',rel:'noopener noreferrer',class:style},label):null;
}
export const option=(value,label=value,selected=false)=>el('option',{value,selected},label);
export const select=(name,values,current,attrs={})=>el('select',{autocomplete:'off',...attrs,name},values.map(item=>{
  const [value,label]=Array.isArray(item)?item:[item,item];
  return option(value,label,value===current);
}));
export function input(name,value='',attrs={}) {
  const control=el('input',{autocomplete:'off',...attrs,name,value:attrs.type==='hidden'||!structuredValue(value)?value:''});
  if(attrs.type!=='hidden') control.addEventListener('input',()=>{if(structuredValue(control.value))control.value='';});
  return control;
}
export const textarea=(name,value='',attrs={})=>el('textarea',{autocomplete:'off',...attrs,name},value);
let fieldCount=0;
export function field(label,node,help) {
  const id='field-label-'+(++fieldCount);
  if (node?.matches('input:not([type="hidden"]),select,textarea')) {
    node.setAttribute('aria-labelledby',id);
    if(help) node.setAttribute('aria-describedby',id+'-help');
  }
  return el('label',{class:'field'},el('span',{id},label),node,help&&el('small',{id:id+'-help'},help));
}
export const check=(name,label,checked=false)=>el('label',{class:'check'},input(name,'1',{type:'checkbox',checked}),el('span',{},label));
export const badge=(label,style='muted')=>el('span',{class:'badge '+style},label);
export const section=(title,...children)=>el('section',{class:'section'},el('h2',{},title),children);
export const blank=(title,description,action)=>el('div',{class:'empty'},el('div',{class:'empty-mark','aria-hidden':'true'}),el('h2',{},title),el('p',{},description),action);
export const dateLabel=value=>{
  if (!value || !Number.isFinite(Date.parse(value))) return 'Unknown';
  return new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'}).format(new Date(value));
};
export const money=value=>new Intl.NumberFormat(undefined,{style:'currency',currency:'USD',minimumFractionDigits:2,maximumFractionDigits:3}).format(value);
export function elements(form) {
  if ([...form.querySelectorAll('input:not([type=hidden])')].some(control=>structuredValue(control.value))) {
    throw new Error('Remove the unexpected prefilled value and enter plain text.');
  }
  return Object.fromEntries(new FormData(form));
}

export function tokenField(name,label,initial,{choices,custom=true,placeholder,change}={}) {
  let values=distinctValues(initial);
  const hidden=input(name,'',{type:'hidden'});
  const tokens=el('div',{class:'tokens'});
  const picker=choices&&select(undefined,[['','Choose an option'],...choices],'',{'aria-label':'Choose '+label.toLowerCase()});
  const editor=custom&&input(undefined,'',{placeholder:placeholder??'Type and press Enter','aria-label':label,spellcheck:'false',maxlength:10000});
  function show() {
    hidden.value=JSON.stringify(values);
    tokens.replaceChildren(...values.map(value=>el('span',{class:'token'},value,button('×',()=>{
      values=values.filter(item=>item!==value);
      show();
      (editor||picker)?.focus();
    },'token-remove',{'aria-label':'Remove '+value}))));
    change?.(values);
  }
  function add(value) {
    if(structuredValue(value)) {if(editor)editor.value='';toast('Enter plain text for '+label.toLowerCase()+'.',true);return;}
    const entries=distinctValues(value);
    if(entries.some(entry=>entry.length>240)){toast('Keep each entry to 240 characters or fewer.',true);return;}
    values=distinctValues([...values,...entries]);
    show();
  }
  function commit() {
    if(editor?.value.trim()){add(editor.value);editor.value='';}
  }
  if(picker) {
    picker.hidden=!choices.length;
    picker.addEventListener('change',()=>{if(picker.value)add(picker.value);picker.value='';});
  }
  if(editor) {
    editor.addEventListener('keydown',event=>{
      if(!event.isComposing&&['Enter',','].includes(event.key)) {event.preventDefault();commit();}
    });
    editor.addEventListener('blur',commit);
    editor.addEventListener('input',()=>{if(structuredValue(editor.value))editor.value='';});
  }
  show();
  const root=el('div',{class:'field token-field'},el('span',{},label),tokens,el('div',{class:'token-controls'},picker,editor,
    editor&&button('Add',commit,'',{'aria-label':'Add '+label.toLowerCase()})),hidden);
  return {root,setChoices(options){
    if(picker) {
      picker.hidden=!options.length;
      picker.replaceChildren(option('','Choose an option'),...options.map(value=>option(value)));
    }
  }};
}
export function readTokens(values,name) {
  try {
    const result=JSON.parse(values[name]??'[]');
    return Array.isArray(result)?distinctValues(result):[];
  } catch {return [];}
}
export const paragraph=(value,cls='subtle')=>el('p',{class:cls},value);
export async function rpc(type,data={}) {
  const response=await chrome.runtime.sendMessage({type,...data});
  if(!response?.ok) throw new Error(response?.error||'MeshJob could not complete this operation.');
  return response.value;
}
export async function permit(origins,permissions=[]) {
  const request={origins:[...new Set(origins)],...(permissions.length?{permissions}:{})};
  if(!await chrome.permissions.request(request)) throw new Error('Site permission was declined.');
}
export function toast(message,error=false) {
  let node=document.getElementById('toast');
  if(!node){node=el('div',{id:'toast',role:'status','aria-live':'polite',hidden:true});document.body.append(node);}
  node.hidden=false;node.className=error?'toast error':'toast';node.textContent=message;
  clearTimeout(toast.timer);
  toast.timer=setTimeout(()=>{node.hidden=true;},6500);
}
export function task(action,success) {
  return async event=>{
    const node=event?.currentTarget;
    const old=node?.disabled;
    if(node?.tagName==='BUTTON') node.disabled=true;
    try {
      const result=await action(event);
      if(success) toast(typeof success==='function'?success(result):success);
      return result;
    } catch(error) {toast(error.message??String(error),true);}
    finally {if(node?.tagName==='BUTTON') node.disabled=old;}
  };
}
export function formDialog(title,body,submit,label='Save') {
  const titleId='dialog-'+crypto.randomUUID();
  const dialog=el('dialog',{class:'dialog','aria-labelledby':titleId});
  const titleNode=el('h2',{id:titleId},title);
  const errors=el('p',{class:'form-error',role:'alert',hidden:true});
  const form=el('form',{autocomplete:'off'},el('header',{class:'dialog-header'},titleNode,
    button('×',()=>dialog.close(),'icon',{'aria-label':'Close'})),
    el('div',{class:'dialog-body'},body,errors),
    ...(submit?[el('footer',{class:'dialog-actions'},button('Cancel',()=>dialog.close()),el('button',{class:'button primary',type:'submit'},label))]:[]));
  if(submit) form.addEventListener('submit',async event=>{
    event.preventDefault();errors.hidden=true;
    const trigger=event.submitter;
    if(trigger)trigger.disabled=true;
    try{if(await submit(elements(form),form,dialog)!==false)dialog.close();}
    catch(error){errors.textContent=error.message;errors.hidden=false;}
    finally{if(trigger)trigger.disabled=false;}
  });
  dialog.append(form);
  document.body.append(dialog);
  dialog.addEventListener('close',()=>dialog.remove(),{once:true});
  dialog.showModal();
  return {dialog,form};
}
export function download(name,payload,type='text/csv;charset=utf-8') {
  const url=URL.createObjectURL(payload instanceof Blob?payload:new Blob([payload],{type}));
  const anchor=el('a',{href:url,download:name});
  document.body.append(anchor);
  anchor.click();anchor.remove();
  setTimeout(()=>URL.revokeObjectURL(url),30_000);
}
export function dataTable(headers,rows,caption,style='') {
  return el('div',{class:('table-wrap '+style).trim()},el('table',{},caption&&el('caption',{},caption),
    el('thead',{},el('tr',{},headers.map(label=>el('th',{scope:'col'},label)))),
    el('tbody',{},rows.map(row=>el('tr',{},row.map(item=>el('td',{},item)))))));
}
