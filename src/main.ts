import '@fontsource/geist/latin-400.css';
import '@fontsource/geist/latin-500.css';
import '@fontsource/geist/latin-600.css';
import '@fontsource/geist/latin-700.css';
import '@fontsource/bricolage-grotesque/latin-700.css';
import '@fontsource/bricolage-grotesque/latin-800.css';
import '@fontsource/instrument-sans/latin-400.css';
import '@fontsource/instrument-sans/latin-500.css';
import '@fontsource/instrument-sans/latin-600.css';
import '@fontsource/instrument-sans/latin-700.css';
import './styles.css';
import './visual-novo.css';
import { applyVisual } from './visual';

import { registerSW } from 'virtual:pwa-register';
import { startInstall } from './instalar';
import { db, setMeta } from './db';
import { importBackup } from './backup';
import { currentSession, onSyncStatus, scheduleSync, startAutoSync, supabase, type SyncStatus } from './sync';
import { S, current, startStore, subscribe } from './store';
import { startRouter } from './router';
import { $, closeSheets, pl, stickyToast, toast } from './ui';
import { initPostos } from './screens/postos';
import { initAbastecer } from './screens/abastecer';
import { initCarros } from './screens/carros';
import { initCarro } from './screens/carro';
import { initLocais } from './screens/locais';
import { initImportar } from './screens/importar';
import { captureAuthorization, initAutorizar, pendingAuthorization } from './screens/autorizar';
import { initRelato } from './screens/relato';
import { initInicio } from './screens/inicio';
import { initPerfil } from './screens/perfil';
import { initAdmin } from './screens/admin';
import { applyConsentChoice, hideWelcome, shouldWelcome, showWelcome } from './screens/boasvindas';
import { maybeCarStep } from './screens/primeirocarro';
import { track } from './uso';
import { currentRoute } from './router';

/* ---------- sincronização: texto do status ---------- */
let syncStatus: SyncStatus = { kind: 'signed-out' };
let signedIn = false;
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
function syncText(): [string, string] {
  const n = S.pending;
  switch (syncStatus.kind) {
    case 'signed-out': return ['', 'Salvo só neste aparelho'];
    case 'offline': return ['wait', n ? 'Sem internet · ' + n + ' a enviar' : 'Sem internet'];
    case 'syncing': return ['wait', 'Sincronizando…'];
    case 'ok': return n ? ['wait', n + ' a enviar'] : ['on', 'Sincronizado às ' + hhmm(syncStatus.at)];
    case 'error': return ['err', 'Sincronização falhou'];
  }
}
function renderSync() {
  const [cls, txt] = syncText();
  const el = $('sync');
  el.className = 'sync ' + cls;
  el.lastElementChild!.textContent = txt;
}

/* ---------- telas ---------- */
const carros = initCarros();
const postos = initPostos({ fillAt: (s, fuel, price) => fill.openAt(s, fuel, price) });
const fill = initAbastecer(postos, () => carros.openVehicle(null, () => fill.open(null)));
initCarro(fill);
initLocais();
const importar = initImportar();
initAutorizar();
initRelato();
initAdmin();
const authorizing = captureAuthorization();
const perfil = initPerfil({ status: () => syncStatus, statusText: () => syncText()[1] });
initInicio({ signedIn: () => signedIn, renderRec: postos.renderHome, answerAfter: (id, v) => fill.answerAfter(id, v) });

$('add-btn').addEventListener('click', () => fill.open(null));

/* ---------- ações compartilhadas ---------- */
$('scrim').addEventListener('click', () => closeSheets());
document.addEventListener('click', async (e) => {
  if ((e.target as HTMLElement).closest('[data-close]')) return closeSheets();
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
  if (!el) return;
  if (el.dataset.act === 'import') $<HTMLInputElement>('imp-file').click();
  if (el.dataset.act === 'fill') fill.open(null);
});
$<HTMLInputElement>('imp-file').addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  // planilha ou resposta da IA: vai para "Trazer histórico", que confere antes de gravar
  if (!/\.json$/i.test(file.name) || !/"app"\s*:/.test(await file.text())) return importar.openFile(file);
  try {
    const res = await importBackup(JSON.parse(await file.text()));
    if (!current()) {
      const first = (await db.vehicles.toArray()).find((v) => !v.archived && !v.deleted_at);
      if (first) await setMeta('current_vehicle', first.id);
    }
    toast('Importado: ' + pl(res.vehicles, 'carro', 'carros') + ', ' + pl(res.fuel_logs, 'abastecimento', 'abastecimentos') + ', ' + pl(res.services, 'manutenção', 'manutenções'));
  } catch (err) {
    toast(err instanceof SyntaxError ? 'Arquivo inválido: não é um JSON.' : (err as Error).message);
  }
});

/* ---------- estado e sincronização ---------- */
startStore((e) => {
  console.error(e);
  toast('Não consegui ler a base deste aparelho. Feche e abra o app de novo.');
});
subscribe(() => {
  renderSync();
  if (S.pending > 0 && syncStatus.kind !== 'signed-out') scheduleSync();
});
onSyncStatus((st) => {
  syncStatus = st;
  renderSync();
});

/** Depois da primeira sincronização (ou 8 s, ou sem internet): só então dá para saber se a conta tem carro. */
function afterSync(): Promise<void> {
  return new Promise((done) => {
    const settled = (k: SyncStatus['kind']) => k === 'ok' || k === 'error' || k === 'offline';
    let off = () => {};
    const t = setTimeout(() => { off(); done(); }, 8000);
    off = onSyncStatus((st) => {
      if (settled(st.kind)) { clearTimeout(t); queueMicrotask(() => off()); done(); }
    }) as () => void;
  });
}
const carStep = () => { if (!pendingAuthorization()) maybeCarStep(); };

async function boot() {
  applyVisual();
  signedIn = !!(await currentSession());
  startRouter();
  track('open');
  track('view', currentRoute().view);
  addEventListener('hashchange', () => track('view', currentRoute().view));
  // pedido de conexão do Claude: vai direto para a autorização, sem boas-vindas
  if (authorizing || pendingAuthorization()) return;
  if (await shouldWelcome(signedIn)) return showWelcome({ onClose: carStep });
  if (signedIn) await afterSync();
  carStep();
}

supabase.auth.onAuthStateChange((event) => {
  if (event === 'SIGNED_IN') {
    signedIn = true;
    hideWelcome();
    track('login_ok');
    applyConsentChoice();
    afterSync().then(carStep);
  }
  if (event === 'SIGNED_OUT') signedIn = false;
});

/* ---------- PWA ---------- */
startInstall();
const updateSW = registerSW({
  onNeedRefresh() {
    stickyToast('Nova versão disponível', 'Atualizar', () => updateSW(true));
  },
  onOfflineReady() {
    toast('Pronto para usar sem internet');
  },
});
navigator.storage?.persist?.().catch(() => {});
startAutoSync();

/* ---------- volta do link do e-mail ---------- */
{
  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.get('error_code') || hash.get('error')) {
    const expired = /expired|invalid/i.test(hash.get('error_code') + ' ' + hash.get('error_description'));
    history.replaceState(null, '', location.pathname);
    setTimeout(() => toast(expired ? 'O link expirou ou já foi usado. Peça outro no Perfil.' : 'Não foi possível entrar pelo link. Tente de novo.'), 600);
  } else if (hash.get('access_token')) {
    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_IN') {
        toast('Conta conectada. Sincronizando…');
        history.replaceState(null, '', location.pathname + (pendingAuthorization() ? '#/autorizar' : '#/inicio'));
        data.subscription.unsubscribe();
      }
    });
  }
}
boot();
