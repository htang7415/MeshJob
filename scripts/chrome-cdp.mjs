import { spawn } from 'node:child_process';
import { once } from 'node:events';

export function openChrome(executable,profile,{socket=false,stderr=process.stderr}={}) {
  const child=spawn(executable,['--headless','--disable-gpu','--disable-background-networking','--no-first-run','--no-default-browser-check',
    '--enable-unsafe-extension-debugging','--remote-debugging-pipe','--user-data-dir='+profile,
    ...(socket?['--remote-debugging-port=0','--remote-debugging-address=127.0.0.1']:[]),
    'about:blank'],{stdio:['ignore','ignore','pipe','pipe','pipe']});
  const pending=new Map();
  let partial='',nextId=0;
  let debugSocket;
  function cancel(error) {
    for(const [id,request] of pending) {
      clearTimeout(request.timer);request.reject(error);pending.delete(id);
    }
  }
  child.on('error',cancel);
  child.on('exit',()=>cancel(new Error('Disposable Chrome exited.')));
  child.stdio[3].on('error',cancel);
  child.stderr.setEncoding('utf8').on('data',value=>{
    debugSocket ||= /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[^\s]+)/.exec(value)?.[1];
    stderr?.write(value);
  });
  child.stdio[4].setEncoding('utf8').on('data',data=>{
    partial+=data;
    const fragments=partial.split('\0');
    partial=fragments.pop();
    for(const fragment of fragments) {
      if(!fragment) continue;
      const message=JSON.parse(fragment);
      const request=pending.get(message.id);
      if(!request) continue;
      pending.delete(message.id);
      clearTimeout(request.timer);
      if(message.error) request.reject(new Error(request.method+' '+message.error.message));
      else request.resolve(message.result);
    }
  });
  function send(method,params={},sessionId) {
    return new Promise((resolve,reject)=>{
      const id=++nextId;
      const timer=setTimeout(()=>{
        pending.delete(id);reject(new Error('Timed out on '+method));
      },30000);
      pending.set(id,{method,timer,resolve,reject});
      child.stdio[3].write(JSON.stringify({id,method,params,sessionId})+'\0');
    });
  }
  async function close() {
    if(child.exitCode!=null||child.signalCode!=null) return;
    void send('Browser.close').catch(()=>{});
    const exited=once(child,'exit').catch(()=>{});
    let kill;
    await Promise.race([exited,new Promise(resolve=>{
      kill=setTimeout(()=>{child.kill('SIGTERM');resolve();},3000);
    })]);
    clearTimeout(kill);
  }
  return {send,close,socketUrl:()=>debugSocket};
}
