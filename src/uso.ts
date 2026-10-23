// Medir uso do app: por onde as pessoas passam (funil do primeiro acesso, telas, caminhos).
// Pseudônimo: um id aleatório do aparelho e um por abertura do app. Nada de conta, e-mail, localização, preço
// ou texto digitado. Desligável no Perfil ("Medir uso do app"). Os números só aparecem agregados no painel.
import { supabase } from './sync';

export type UsoEv = 'open' | 'view' | 'welcome' | 'welcome_skip' | 'login_link' | 'login_code' | 'login_ok'
  | 'car_step' | 'car_skip' | 'car_created' | 'fill_open' | 'fill_saved' | 'price_seen' | 'push_on' | 'import_open';

const OFF = 'uso_off';
const get = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const put = (k: string, v: string | null) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* sem acesso */ } };
const rid = () => (crypto.randomUUID ? crypto.randomUUID() : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) => (+c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (+c / 4)))).toString(16)));

export const usoOn = () => get(OFF) !== '1';
/** Aparelho de administrador: não entra na medição (marcado ao entrar com conta de admin; fica marcado). */
export function markAdminDevice() {
  put('uso_admin', '1');
  queue.length = 0;
}
const isAdminDevice = () => get('uso_admin') === '1';
export function setUso(on: boolean) {
  put(OFF, on ? null : '1');
  if (!on) queue.length = 0;
}

let dev = get('uso_dev');
if (!dev) { dev = rid(); put('uso_dev', dev); }
const sess = rid();
const plat = (() => {
  const ua = navigator.userAgent;
  const os = /iPhone|iPad|iPod/.test(ua) ? 'ios' : /Android/.test(ua) ? 'android' : 'desktop';
  const br = /CriOS|Chrome/.test(ua) && !/Edg/.test(ua) ? 'chrome' : /FxiOS|Firefox/.test(ua) ? 'firefox' : /Safari/.test(ua) ? 'safari' : 'outro';
  const app = matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone ? ' app' : '';
  return os + ' ' + br + app;
})();
declare const __BUILD__: string;
const ver = __BUILD__.replace(/\D/g, '').slice(0, 12) || null;

type Row = { dev: string; sess: string; ev: UsoEv; view?: string; plat: string; ver: string | null };
const queue: Row[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

export function track(ev: UsoEv, view?: string) {
  if (!usoOn() || isAdminDevice()) return;
  queue.push({ dev: dev!, sess, ev, view: view && /^[a-z]{2,15}$/.test(view) ? view : undefined, plat, ver });
  if (queue.length >= 40) flush();
  else if (!timer) timer = setTimeout(flush, 8000);
}

export function flush() {
  if (timer) { clearTimeout(timer); timer = null; }
  if (!queue.length || navigator.onLine === false) return;
  const batch = queue.splice(0, 50);
  supabase.rpc('log_events', { batch }).then(({ error }) => { if (error) console.warn('uso', error.message); });
}

addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
addEventListener('pagehide', flush);
