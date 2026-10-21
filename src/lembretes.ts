// Lembrete por notificação no dia seguinte ao abastecimento ("como o carro andou?").
// O aparelho se inscreve no serviço de push do próprio navegador com a chave pública do servidor
// (função `lembretes`) e guarda a inscrição em push_subscriptions, que só a própria conta vê.
import { SUPABASE_URL } from './config';
import { supabase } from './sync';
import { isStandalone } from './instalar';

const FN = SUPABASE_URL + '/functions/v1/lembretes';

export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
export const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export type PushState = 'on' | 'off' | 'blocked' | 'unsupported' | 'install';

export async function pushState(): Promise<PushState> {
  if (!pushSupported()) return isIOS() && !isStandalone() ? 'install' : 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    return sub ? 'on' : 'off';
  } catch {
    return 'off';
  }
}

function keyBytes(b64url: string): Uint8Array {
  const s = atob(b64url.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64url.length + 3) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

/** Liga: pede permissão, inscreve o aparelho e guarda na conta. Devolve uma mensagem de erro, ou null. */
export async function enablePush(): Promise<string | null> {
  if (!pushSupported()) return isIOS() ? 'No iPhone, instale o app na tela inicial (Compartilhar › Adicionar à Tela de Início) e ligue por lá.' : 'Este navegador não recebe notificações.';
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return 'As notificações estão bloqueadas para o app. Libere nas configurações do navegador.';
  try {
    const reg = await navigator.serviceWorker.ready;
    const r = await fetch(FN + '/chave', { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error('chave ' + r.status);
    const { publicKey } = await r.json();
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await Promise.race([
      reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) as BufferSource }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('push: tempo esgotado')), 20000)),
    ]);
    const j = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
    const { error } = await supabase.from('push_subscriptions').upsert({ endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth }, { onConflict: 'endpoint' });
    if (error) throw error;
    return null;
  } catch (e) {
    console.error('push', e);
    return 'Não deu para ligar agora. Tente de novo em instantes.';
  }
}

/** Desliga: tira a inscrição do aparelho e da conta. */
export async function disablePush(): Promise<void> {
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    if (!sub) return;
    await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
    await sub.unsubscribe();
  } catch (e) {
    console.error('push', e);
  }
}
