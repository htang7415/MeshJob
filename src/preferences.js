import regions from './regions.json' with {type:'json'};

export const LEVELS=['Intern','Entry','Mid','Senior','Staff+','Manager'];
export const EXPERIENCE_LEVELS=LEVELS;
const LEGACY_LEVELS={internship:['Intern'],'entry level':['Entry'],associate:['Entry'],'mid senior level':['Mid','Senior','Staff+'],
  director:['Manager'],executive:['Manager'],junior:['Entry'],'new grad':['Entry'],'early career':['Entry'],'mid level':['Mid'],
  staff:['Staff+'],principal:['Staff+'],lead:['Senior'],senior:['Senior']};
const key=value=>String(value??'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}+]+/gu,' ').trim();
export function normalizeLevels(values) {
  const out=new Set();
  for(const value of [values??[]].flat()) {
    const direct=LEVELS.find(level=>key(level)===key(value));
    if(direct) out.add(direct);
    else for(const level of LEGACY_LEVELS[key(value)]??[]) out.add(level);
  }
  return LEVELS.filter(level=>out.has(level));
}
export const EMPLOYMENT_TYPES=['Full-time','Part-time','Contract','Temporary','Internship','Volunteer','Other'];
export const WORKPLACE_TYPES=['On-site','Hybrid','Remote'];
export const PRIORITIES=['High','Medium','Low'];
const english=new Intl.DisplayNames(['en'],{type:'region'});
const countryCodes=new Map(Object.keys(regions).map(code=>[english.of(code),code]));
export const COUNTRY_OPTIONS=[...countryCodes.keys()].sort((a,b)=>a.localeCompare(b));
export const regionOptions=countries=>[...new Set(countries.flatMap(country=>regions[countryCodes.get(country)]??[]))]
  .sort((a,b)=>a.localeCompare(b));
