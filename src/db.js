import Dexie from 'dexie';
import { DEFAULTS, distinctValues, structuredValue } from './domain.js';

export const db = new Dexie('meshjob');
db.version(1).stores({
  settings: 'id', sources: 'id, provider, enabled, nextAt',
  jobs: 'id, *keys, *urls, *sourceIds, active, firstSeenAt',
  materials: 'id, type', answers:'id, questionKey',
  applications: 'id, &jobId, status, appliedAt, updatedAt',
  events: 'id, applicationId, &messageId, at, urgent, resolvedAt, threadId',
  runtime: 'id, kind, expiresAt', usage: 'id, month, day, kind, at'
});
export async function settings() {
  const saved = await db.settings.get('settings');
  const preferences={...DEFAULTS.preferences,...saved?.preferences};
  for(const [key,value] of Object.entries(DEFAULTS.preferences)) {
    if(Array.isArray(value)) preferences[key]=distinctValues(preferences[key]);
  }
  const profile={...saved?.profile};
  for(const [key,value] of Object.entries(profile)) {
    if(key==='skills') profile.skills=distinctValues(value);
    else if(key!=='summary'&&structuredValue(value)) profile[key]='';
  }
  return { ...DEFAULTS, ...saved, preferences, profile, id:'settings' };
}
export async function updateSettings(update) {
  return db.transaction('rw', db.settings, async () => {
    const current = await settings();
    const next = typeof update === 'function' ? update(current) : { ...current, ...update };
    await db.settings.put({ ...next, id:'settings' });
    return next;
  });
}
export async function guarded(expected, tables, update) {
  return db.transaction('rw', db.settings, ...tables, async () => {
    if (expected != null) {
      const config = await settings();
      if (config.generation !== expected || config.mode !== 'Active') return null;
    }
    return update();
  });
}
export async function claim(id, kind, duration, generation = null) {
  const token = crypto.randomUUID();
  const acquired = await guarded(generation, [db.runtime], async () => {
    if ((await db.runtime.get(id))?.expiresAt > Date.now()) return false;
    await db.runtime.put({ id, kind, token, expiresAt:Date.now()+duration });
    return true;
  });
  return acquired ? token : null;
}
export async function release(id, token) {
  await db.transaction('rw', db.runtime, async () => {
    if ((await db.runtime.get(id))?.token === token) await db.runtime.delete(id);
  });
}
