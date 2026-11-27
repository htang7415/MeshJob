import { distinctValues, httpUrl, normalized, structuredValue } from './domain.js';

export function greenhouseEmbed(value) {
  const url=httpUrl(value);
  if(url?.protocol!=='https:' || url.port || !['job-boards.greenhouse.io','boards.greenhouse.io'].includes(url.hostname) ||
     url.pathname!=='/embed/job_app') return null;
  const board=url.searchParams.get('for'), id=url.searchParams.get('token');
  return /^[a-z0-9_-]{1,100}$/i.test(board??'')&&/^\d{1,20}$/.test(id??'') ? {origin:url.origin,board:board.toLowerCase(),id} : null;
}

export const PROFILE_KEYS = {
  givenName:'First name',familyName:'Last name',fullName:'Full name',preferredName:'Preferred name',email:'Email',
  phone:'Phone',phoneCountry:'Phone country code',address1:'Address line 1',address2:'Address line 2',
  city:'City',region:'State or region',postal:'Postal code',country:'Country',linkedin:'LinkedIn URL',
  website:'Website or portfolio',github:'GitHub URL',currentEmployer:'Current employer',currentTitle:'Current title'
};

export function criticalField(value) {
  return /\b(?:authori[sz](?:ation|ed)|right to work|work eligibility|permission to work|work legally|legally permitted|petition on your behalf|visa|sponsor(?:ship)?|citizen(?:ship)?|permanent resident|h1b|h 1b|stem opt|opt|immigration|work permit|legal(?:ly)? eligible|eligible to work|employment eligibility|security clearance|criminal|convict|felony|drug test|background check|gender|sex(?:ual orientation)?|lgbtq(?:ia)?|race|ethnic(?:ity)?|veteran|disabilit(?:y|ies)|eeo|diversity|demographic|age|birth|native american|indigenous|hispanic|latino|pronouns?|government id|social security|ssn)\b/.test(normalized(value));
}
export function consentField(value) {
  return /\b(?:i agree|i accept|agree to|accept the|consent|certif(?:y|ication)|affirm|acknowledge|privacy policy|privacy notice|terms and conditions|signature|sign your|electronic sign|legally binding|accuracy of (?:the )?information)\b/.test(normalized(value));
}

const yesNo=['Yes','No'];
const optionalDisclosure=['Yes','No','Prefer not to answer'];
// Standard choices (EEO-1 / OMB categories and common US work-authorization answers), so answers map to any form's options.
export const RACE_CHOICES=['East Asian','South Asian','Southeast Asian','Asian','Black or African American','Hispanic or Latino','White',
  'Middle Eastern or North African','American Indian or Alaska Native','Native Hawaiian or Other Pacific Islander','Two or More Races','Prefer not to answer'];
export const ANSWER_PRESETS=[
  {question:'Countries where you want to work',countries:true,aliases:['In which countries would you like to work?','Which countries do you want to work in?']},
  {question:'Are you a citizen of the United States?',choices:yesNo,aliases:['Are you a U.S. citizen?','Are you a US citizen?']},
  {question:'Are you legally authorized to work in the United States?',choices:yesNo,aliases:['Are you legally authorized to work in the US?','Are you legally authorized to work in the U.S.?','Are you authorized to work in the United States?','Are you authorized to work in the US?']},
  {question:'Will you now or in the future require employer sponsorship in the United States?',choices:yesNo,
    aliases:['Will you now or in the future require sponsorship to work in the US?','Will you now or in the future require sponsorship to work in the United States?',
      'Will you now or in the future require sponsorship for employment visa status (e.g., H-1B visa status)?','Will you now, or in the future, require sponsorship for employment visa status?',
      'Will you require visa sponsorship?','Do you require visa sponsorship?']},
  {question:'United States: Authorization basis',choices:['U.S. citizen','Permanent resident (green card)','Work visa','Student visa (F-1 OPT or CPT)','Other'],aliases:['Authorization basis (United States)']},
  {question:'United States: Work permit or visa type',choices:['None needed (citizen or permanent resident)','F-1 OPT','F-1 STEM OPT','F-1 CPT','H-1B','H-4 EAD','L-1','O-1','TN','E-3','Other'],
    aliases:['Work permit or visa type (United States)','What is your current visa status?','Current visa status']},
  {question:'Do you have a disability?',choices:optionalDisclosure,aliases:['Disability status','Disability','Do you have a disability or chronic condition?']},
  {question:'Do you identify as LGBTQ+?',choices:optionalDisclosure,aliases:['Do you identify as LGBTQ?','LGBTQ+']},
  {question:'What is your gender?',choices:['Male','Female','Non-binary','Prefer not to answer'],aliases:['Gender','Gender identity','What is your gender identity?']},
  {question:'Are you a veteran?',choices:optionalDisclosure,aliases:['Veteran status','Protected veteran status','Are you a protected veteran?']},
  {question:'How would you identify your race?',choices:RACE_CHOICES,aliases:['Race','Race/Ethnicity','Race / Ethnicity','Ethnicity','What is your race?','Please identify your race']},
  {question:'Are you Hispanic or Latino?',choices:optionalDisclosure,aliases:['Are you Hispanic/Latino?','Hispanic/Latino','Hispanic or Latino']},
  {question:'How would you describe your sexual orientation? (Mark all that apply)',choices:['Heterosexual','Gay','Lesbian','Bisexual','Asexual','Queer','Prefer not to answer'],
    aliases:['How would you describe your sexual orientation?','Sexual orientation']},
  {question:'What are your pronouns?',choices:['He/him','She/her','They/them','Prefer not to answer'],aliases:['Pronouns']}
];
const questionText=value=>normalized(value).replace(/\b(?:required|optional)$/, '').trim();
const aliases=new Map(ANSWER_PRESETS.flatMap(preset=>(preset.aliases??[]).map(alias=>[questionText(alias),questionText(preset.question)])));
export const fieldQuestion = value => {
  const text=questionText(value);
  return aliases.get(text)??text;
};
const transforms = {
  'given-name':'givenName','family-name':'familyName',name:'fullName',nickname:'preferredName',email:'email',tel:'phone',
  'tel-country-code':'phoneCountry','address-line1':'address1','street-address':'address1','address-line2':'address2',
  'address-level2':'city','address-level1':'region',country:'country','country-name':'country','postal-code':'postal',
  organization:'currentEmployer','organization-title':'currentTitle'
};
const rules = [
  ['givenName',/^(?:legal )?(?:first|given|forename) name$|^(?:first|firstname|forename)$/],
  ['familyName',/^(?:legal )?(?:last|family|sur) name$|^surname$|^last$|^lastname$/],
  ['preferredName',/^(?:preferred|chosen|display) (?:(?:first|given) )?name$/],
  ['fullName',/^(?:(?:legal )?full |applicant |your )?name$|^fullname$/],
  ['email',/^(?:(?:primary|contact|personal|login|confirm|re enter) )?e ?mail(?: address)?$/],
  ['phoneCountry',/^(?:phone |telephone |mobile )?country (?:dialing )?code$/],
  ['phone',/^(?:(?:primary|contact|mobile|home|cell|daytime) )?(?:phone|telephone|mobile|cell)(?: number)?$/],
  ['address2',/^(?:(?:street |home |mailing )?address (?:line )?2|apt(?: suite)?|apartment|suite)(?: number)?$/],
  ['address1',/^(?:(?:street |home |mailing )?address(?: (?:line )?1)?|street)$/],
  ['city',/^(?:home |current )?(?:city|town|municipality)$/],
  ['region',/^(?:home |current )?(?:state|province|region|state province(?: region)?|territory)$/],
  ['postal',/^(?:zip|zip postal|postal|post) code$|^zip$/],
  ['country',/^(?:current |home )?country(?: (?:of )?residence| region)?$/],
  ['linkedin',/^linkedin(?: profile| url| profile url)?$/],
  ['github',/^github(?: profile| url| profile url)?$/],
  ['website',/^(?:personal )?(?:website|portfolio)(?: link| url)?$/],
  ['currentEmployer',/^(?:current employer|current company|company name|employer name)$/],
  ['currentTitle',/^(?:current title|current job title|current position|job title)$/]
];
export function fieldKey(field) {
  const name = fieldQuestion(field.label);
  const identifiers = normalized(String(field.name ?? '').replace(/([a-z])([A-Z])/g,'$1 $2'));
  if (criticalField(name+' '+identifiers) || consentField(name+' '+identifiers) || field.type==='password') return null;
  if (field.type === 'file') {
    if (/\b(?:resume|résumé|curriculum vitae|cv)\b/.test(name+' '+identifiers)) return 'resume';
    if (/\bcover letter\b/.test(name+' '+identifiers)) return 'cover';
    return null;
  }
  if (field.type==='textarea' && /^cover letter(?: text)?$/.test(name)) return 'coverText';
  if (field.group) return null;
  if (['text','textarea','select','skill-picker'].includes(field.type) && /^(?:add |search for )?skills$/.test(name)) return 'skills';
  const exact=rules.find(([,r])=>r.test(name))?.[0];
  if (exact) return exact;
  const hasLabel=name && name!==identifiers && field.labelSource!=='identifier';
  const inferred=field.autocomplete && transforms[field.autocomplete];
  if (inferred && (!hasLabel || /^(?:your identity|your information|email|phone)$/.test(name))) return inferred;
  if (hasLabel) return null;
  if (field.type==='email') return 'email';
  if (field.type==='tel') return 'phone';
  return rules.find(([,r])=>r.test(identifiers))?.[0] ?? null;
}

export const registrationEmailField=field=>['text','email'].includes(field.type)&&fieldKey(field)==='email';

const SCHOOL=/^(?:school|university|college|institution|school or university|college university)(?: name)?$/;
// A follow-up asked after choosing "Other" for a school that is not in the form's list.
const OTHER_SCHOOL=/^(?:other school|other university|other institution|school name if other|if other.*|please specify.*|school not listed|name of (?:your )?(?:school|university)|enter (?:your )?school(?: name)?)$/;
const EDUCATION_LABEL=/^(?:school|university|college|institution|school or university|college university|school name|university name|other school|other university|school name if other|school not listed|name of (?:your )?(?:school|university)|degree|degree type|highest degree|level of education|major|field of study|discipline|area of study|concentration|gpa|cumulative gpa|(?:expected )?graduation(?: date| month| year)?)$/;
// Forms without repeated rows (e.g. Greenhouse) ask about one school: use the first education entry.
export const educationField = (field,otherSchool=false) => !field.group && (profileEducation(field) ||
  otherSchool && ['text','textarea'].includes(field.type) && /^(?:if other.*|please specify.*|other|specify)$/.test(fieldQuestion(field.label))) ? {...field,group:{kind:'education',index:0}} : field;
const profileEducation = field => EDUCATION_LABEL.test(fieldQuestion(field.label)) && field.type!=='file';
function rowValue(field, profile) {
  if (!field.group) return null;
  const rows = field.group.kind === 'education' ? profile.education : profile.experience;
  const row = rows?.[field.group.index];
  if (!row) return null;
  const label = fieldQuestion(field.label);
  const raw = fieldQuestion(String(field.name ?? '').replace(/([a-z])([A-Z])/g,'$1 $2'));
  const keys = {
    education:[['school',SCHOOL],['school',OTHER_SCHOOL],['degree',/^(?:degree|degree type|highest degree|level of education|education level)$/],
      ['field',/^(?:field of study|major|discipline|area of study|concentration|major field of study)$/],['gpa',/^(?:gpa|cumulative gpa|overall gpa)$/]],
    experience:[['employer',/^(?:employer|company|organization)(?: name)?$/],['title',/^(?:job title|position|role|title)$/],['location',/^location$/],['description',/^(?:description|responsibilities|role description)$/]]
  };
  const date = value => {
    if (/^(?:start date|start month|start year|from)$/.test(value)) return 'start';
    if (/^(?:end date|end month|end year|to|(?:expected )?graduation(?: date| month| year)?)$/.test(value)) return 'end';
    return null;
  };
  const currentLabel=field.group.kind==='education'
    ? /^(?:i )?(?:currently study here|am currently enrolled)(?: at this (?:school|university|college))?$/
    : /^(?:i )?currently work (?:here|in this role|at this company)$|^current (?:job|role|position)$/;
  if(field.type==='checkbox') return row.current===true&&currentLabel.test(label)?'true':null;
  const time = date(label) ?? date(raw);
  if(time==='end' && row.current===true) return null;
  if (time && row[time]) {
    if (field.type==='month') return row[time].slice(0,7);
    if (field.type==='date' && /^\d{4,}-\d{2}$/.test(row[time])) return null;
    if (label.includes('month')) return row[time].slice(5,7);
    if (label.includes('year')) return row[time].slice(0,4);
    return row[time];
  }
  const key = keys[field.group.kind]?.find(([,pattern])=>pattern.test(label)||pattern.test(raw))?.[0];
  return key ? row[key] : null;
}
export function reusableAnswer(field,answers,job) {
  const matches = answers.filter(answer=>answer.verified && fieldQuestion(answer.questionKey)===fieldQuestion(field.label) &&
    (answer.type==='any'||answer.type===field.type) &&
    (answer.scope==='global' || answer.scope==='company'&&normalized(answer.context)===normalized(job.company) ||
     answer.scope==='role'&&normalized(answer.context)===normalized(job.title)));
  const specificity = {global:0,company:1,role:1};
  matches.sort((a,b)=>specificity[b.scope]-specificity[a.scope]);
  if (!matches.length || matches.slice(1).some(answer=>specificity[answer.scope]===specificity[matches[0].scope]&&answer.value!==matches[0].value)) return null;
  return matches[0];
}
export function createFillPlan(fields,{profile={},answers=[],job={},materials={},maps=[],drafts=[],otherSchool=false}) {
  return fields.flatMap(field=>{
    if (field.filled && field.type!=='skill-picker' || field.disabled || field.consent || consentField(field.label) || field.type==='password') return [];
    const critical = field.critical || criticalField(field.label);
    const verified = reusableAnswer(field,answers,job);
    if (verified && field.type !== 'file' && !structuredValue(verified.value)) return [{id:field.id,value:verified.value,authority:'verified'}];
    if (critical) return [];
    field = educationField(field,otherSchool);
    const workValue=rowValue(field,profile);
    if (field.type==='checkbox' || field.type==='radio') return workValue==='true' && field.type==='checkbox'
      ? [{id:field.id,value:workValue,authority:'profile'}]:[];
    const key = fieldKey(field);
    if(key==='skills') {
      const skills=distinctValues(profile.skills);
      if(!skills.length||field.partial) return [];
      return [{id:field.id,value:skills.join(', '),...(field.type==='skill-picker'||field.multiple?{skills}:{}),authority:'profile'}];
    }
    if (field.type === 'file') return materials[key] ? [{id:field.id,file:materials[key],authority:'selected'}] : [];
    if (key==='coverText') return materials.coverText ? [{id:field.id,value:materials.coverText,authority:'reviewed'}] : [];
    const mapKey = maps.find(map=>map.id===field.id)?.key;
    const draft = drafts.find(item=>item.id===field.id)?.answer;
    const ordinary = Object.hasOwn(PROFILE_KEYS,mapKey) ? profile[mapKey] : undefined;
    const value = field.group ? workValue : (key && profile[key]) ?? ordinary ?? draft;
    // A school missing from the form's list is entered as "Other"; the follow-up text field then gets the name.
    const fallback = field.group?.kind==='education' && SCHOOL.test(fieldQuestion(field.label)) && ['select','combobox'].includes(field.type) ? 'Other' : undefined;
    return value !== undefined && value !== null && value !== '' && typeof value==='string' && !structuredValue(value) ? [{id:field.id,value:String(value),authority:'profile',...(fallback?{fallback}:{})}] : [];
  });
}

export const RECEIPT_SELECTORS = {
  greenhouse:['#application_confirmation','.application-confirmation','[data-testid="application-confirmation"]'],
  ashby:['[data-testid="application-submitted"]','[data-testid="application-confirmation"]','[class*="applicationSuccess"]'],
  lever:['.application-confirmation','.application-success','.posting-confirmation','[data-qa="thank-you"]'],
  workday:['[data-automation-id="applicationConfirmation"]','[data-automation-id="applicationSubmitted"]','[data-automation-id="jobApplicationConfirmation"]']
};
export function receiptSignature({provider,marker,text,finalVisible}) {
  if (!RECEIPT_SELECTORS[provider]?.includes(marker) || finalVisible) return null;
  const copy=String(text??'').slice(0,1000);
  if (/\b(?:not submitted|not received|submission failed|error submitting|unable to submit|has not been submitted|application was saved|draft application|if you submit|unable to receive|will appear|expected application)\b/i.test(copy)) return null;
  return copy.match(/\b(?:application (?:has been |was |is |successfully )?(?:submitted|received|complete)|(?:received|submitted) your application|thank you for (?:submitting your application|applying))\b/i)?.[0]??null;
}

// Layered option matching (spec 5): exact → synonyms → Yes/No prefix → unique containment. Ambiguity fills nothing.
const regionName=new Intl.DisplayNames(['en'],{type:'region'});
const SYNONYMS=[
  ['united states','united states of america','usa','us','u s','u s a','america'],['united kingdom','uk','u k','great britain','gb','england'],
  ['south korea','korea','republic of korea','korea republic of'],['bachelor s degree','bachelor s','bachelors','bachelor','bs','ba','b s','b a','bsc','b sc','bachelor of science','bachelor of arts'],
  ['master s degree','master s','masters','master','ms','ma','m s','m a','msc','m sc','master of science','master of arts'],
  ['doctorate','phd','ph d','doctor of philosophy','doctoral degree'],['associate s degree','associate degree','associates','associate s'],
  ['high school','high school diploma','ged','secondary school'],
  ['prefer not to answer','decline to answer','i don t wish to answer','i do not wish to answer','i do not want to answer','prefer not to say','decline to self identify',
    'i decline to self identify','i choose not to disclose','choose not to disclose','i prefer not to answer','decline to state'],
  ['hispanic or latino','hispanic latino','hispanic latinx','latino','latina','latinx'],['black or african american','black','african american'],
  ['two or more races','two or more','multiracial','mixed race'],['native hawaiian or other pacific islander','native hawaiian or pacific islander','pacific islander'],
  ['american indian or alaska native','native american','american indian'],['middle eastern or north african','middle eastern','north african','mena'],
  ['male','man','cisgender man'],['female','woman','cisgender woman'],  ['non binary','nonbinary','non binary genderqueer'],['heterosexual','straight','heterosexual straight'],['gay','gay man'],['he him','he him his'],['she her','she her hers'],['they them','they them theirs']
];
// When a form lists only the broader group (e.g. Asian), a more specific saved answer (e.g. East Asian) maps to it.
const PARENT={'east asian':'Asian','south asian':'Asian','southeast asian':'Asian','middle eastern or north african':'White'};
// EEO statements phrased without Yes/No.
const STATEMENTS=[
  [/^(?:no|i am not a (?:protected )?veteran)$/,/\b(?:i am not a protected veteran|not a (?:protected )?veteran|no,? i (?:do not|don t) have a disability|i do not have a disability)\b/],
  [/^yes$/,/\b(?:i identify as one or more of the classifications of protected veteran|i am a protected veteran|yes,? i have a disability)\b/]
];
const US_STATES={AL:'Alabama',AK:'Alaska',AZ:'Arizona',AR:'Arkansas',CA:'California',CO:'Colorado',CT:'Connecticut',DE:'Delaware',DC:'District of Columbia',FL:'Florida',GA:'Georgia',
  HI:'Hawaii',ID:'Idaho',IL:'Illinois',IN:'Indiana',IA:'Iowa',KS:'Kansas',KY:'Kentucky',LA:'Louisiana',ME:'Maine',MD:'Maryland',MA:'Massachusetts',MI:'Michigan',MN:'Minnesota',
  MS:'Mississippi',MO:'Missouri',MT:'Montana',NE:'Nebraska',NV:'Nevada',NH:'New Hampshire',NJ:'New Jersey',NM:'New Mexico',NY:'New York',NC:'North Carolina',ND:'North Dakota',
  OH:'Ohio',OK:'Oklahoma',OR:'Oregon',PA:'Pennsylvania',RI:'Rhode Island',SC:'South Carolina',SD:'South Dakota',TN:'Tennessee',TX:'Texas',UT:'Utah',VT:'Vermont',VA:'Virginia',
  WA:'Washington',WV:'West Virginia',WI:'Wisconsin',WY:'Wyoming',PR:'Puerto Rico',AB:'Alberta',BC:'British Columbia',MB:'Manitoba',NB:'New Brunswick',NL:'Newfoundland and Labrador',
  NS:'Nova Scotia',ON:'Ontario',PE:'Prince Edward Island',QC:'Quebec',SK:'Saskatchewan'};
for(const [code,name] of Object.entries(US_STATES)) SYNONYMS.push([normalized(name),code.toLowerCase()]);
function variants(value) {
  const key=normalized(value);
  const out=new Set([key]);
  for(const group of SYNONYMS) if(group.includes(key)) group.forEach(item=>out.add(item));
  if(/^[a-z]{2}$/.test(key)) {
    try { const name=regionName.of(key.toUpperCase()); if(name&&normalized(name)!==key) out.add(normalized(name)); } catch { /* Not a region code. */ }
  }
  return out;
}
const words=value=>' '+value+' ';
export function pickOption(options,value) {
  const labels=options.map(normalized);
  const unique=indexes=>indexes.length===1?indexes[0]:-1;
  const want=variants(value);
  const exact=labels.flatMap((label,i)=>want.has(label)?[i]:[]);
  if(exact.length) return unique(exact);
  const key=normalized(value);
  if(['yes','no'].includes(key)) {
    const found=unique(labels.flatMap((label,i)=>label.startsWith(key+' ')?[i]:[]));
    if(found>=0) return found;
  }
  const contained=labels.flatMap((label,i)=>[...want].some(item=>item.length>=3&&words(label).includes(words(item)))?[i]:[]);
  if(contained.length) return unique(contained);
  for(const [answer,statement] of STATEMENTS) if(answer.test(key)) {
    const found=unique(labels.flatMap((label,i)=>statement.test(label)?[i]:[]));
    if(found>=0) return found;
  }
  return PARENT[key]?pickOption(options,PARENT[key]):-1;
}
export const requiredLabel=label=>/(?:[*✱]|\(required\))\s*$/i.test(String(label??'').trim());
export const cleanLabel=label=>String(label??'').replace(/\s*(?:[*✱]|\(required\))\s*$/i,'').trim();

// A hand-typed answer is worth offering to save when it is not a profile field, consent, password or file, and is short.
export function learnable(row) {
  if(!row.label||!row.value||row.byMeshJob||row.consent||['password','file','skill-picker'].includes(row.type)) return false;
  if(fieldKey(row)||String(row.value).length>400||cleanLabel(row.label).length>300) return false;
  return !structuredValue(row.value);
}
