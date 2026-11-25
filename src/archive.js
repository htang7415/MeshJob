import { unzipSync, zipSync } from 'fflate';

export function archive(operation,data) {
  if (operation==='zip') return zipSync(data,{level:6});
  if (operation!=='unzip') throw new Error('Unknown archive operation.');
  let total=0, count=0;
  return unzipSync(data,{filter(entry){
    total+=entry.originalSize;
    count++;
    if (count>28000 || total>512_000_000 || !/^(?:manifest\.json|records\.json|pdf\/[a-f\d]{64}\.pdf)$/.test(entry.name)) {
      throw new Error('Backup contains unexpected entries or exceeds the import size limit.');
    }
    return true;
  }});
}
