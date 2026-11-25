import regions from './regions.json';

export const EXPERIENCE_LEVELS=['Internship','Entry level','Associate','Mid-Senior level','Director','Executive'];
export const EMPLOYMENT_TYPES=['Full-time','Part-time','Contract','Temporary','Internship','Volunteer','Other'];
export const WORKPLACE_TYPES=['On-site','Hybrid','Remote'];
export const PRIORITIES=['High','Medium','Low'];
const english=new Intl.DisplayNames(['en'],{type:'region'});
const countryCodes=new Map(Object.keys(regions).map(code=>[english.of(code),code]));
export const COUNTRY_OPTIONS=[...countryCodes.keys()].sort((a,b)=>a.localeCompare(b));
export const regionOptions=countries=>[...new Set(countries.flatMap(country=>regions[countryCodes.get(country)]??[]))]
  .sort((a,b)=>a.localeCompare(b));
