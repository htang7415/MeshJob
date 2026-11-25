import { archive } from './archive.js';

self.onmessage=event=>{
  try {
    const result=archive(event.data.operation,event.data.data);
    const buffers=result instanceof Uint8Array?[result.buffer]:Object.values(result).map(bytes=>bytes.buffer);
    self.postMessage({ok:true,result},[...new Set(buffers)]);
  } catch(error) {self.postMessage({ok:false,error:error.message});}
};
