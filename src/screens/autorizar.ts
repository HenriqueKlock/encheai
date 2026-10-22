// Autorizar um app (o Claude) a usar a conta: tela de consentimento do servidor OAuth do Supabase.
// O Supabase manda a pessoa para <site>/autorizar?authorization_id=…; guardamos o pedido, pedimos login se
// precisar, mostramos quem está pedindo e o que ele poderá fazer, e devolvemos a resposta.
import { currentSession, supabase } from '../sync';
import { $, esc, toast } from '../ui';
import { currentRoute, go, onShow } from '../router';
import { renderLogin } from './conta';
import { ICON } from '../icons';

const KEY = 'oauth_pendente';
const MAX_AGE = 30 * 60 * 1000;

export function pendingAuthorization(): string | null {
  try {
    const p = JSON.parse(localStorage.getItem(KEY) ?? 'null') as { id: string; at: number } | null;
    if (p && Date.now() - p.at < MAX_AGE) return p.id;
  } catch { /* sem acesso */ }
  return null;
}
const clearPending = () => { try { localStorage.removeItem(KEY); } catch { /* sem acesso */ } };

/** Chamado no início: se a página abriu com ?authorization_id=…, guarda e vai para a tela de autorização. */
export function captureAuthorization(): boolean {
  const id = new URLSearchParams(location.search).get('authorization_id');
  if (!id || !/^[A-Za-z0-9_-]{8,200}$/.test(id)) return false;
  try { localStorage.setItem(KEY, JSON.stringify({ id, at: Date.now() })); } catch { /* sem acesso */ }
  history.replaceState(null, '', location.pathname.replace(/autorizar\/?$/, '') + '#/autorizar');
  return true;
}

export function initAutorizar() {
  let busy = false;
  let expired = false;
  const EXPIRED = '<div class="card center"><p class="hint">Este pedido de conexão expirou ou já foi usado. Volte ao Claude e conecte de novo.</p><a class="btn" href="#/perfil">Voltar ao Perfil</a></div>';

  async function render() {
    if (currentRoute().view !== 'autorizar') return;
    const box = $('aut-body');
    const id = pendingAuthorization();
    if (id) expired = false;
    if (!id && expired) {
      box.innerHTML = EXPIRED;
      return;
    }
    if (!id) {
      box.innerHTML = '<div class="card center"><p class="hint">Nenhum pedido de conexão aberto. Para conectar o Claude, comece pelo Claude: Configurações › Conectores.</p><a class="btn" href="#/perfil">Voltar ao Perfil</a></div>';
      return;
    }
    if (!(await currentSession())) {
      box.innerHTML = '<div class="card"><span class="b15">Entre para continuar</span><span class="hint">O Claude pediu para se conectar à sua conta do Enche AI. Entre com o mesmo e-mail que você usa no app; depois você confirma a conexão.</span><div id="aut-login"></div></div>';
      renderLogin($('aut-login'), { compact: true, onDone: render });
      return;
    }
    box.innerHTML = '<div class="empty">Carregando o pedido…</div>';
    const { data, error } = await supabase.auth.oauth.getAuthorizationDetails(id);
    if (currentRoute().view !== 'autorizar') return;
    if (error || !data) {
      clearPending();
      expired = true;
      box.innerHTML = EXPIRED;
      return;
    }
    // já autorizado antes: o Supabase devolve direto para onde voltar
    if (!('authorization_id' in data) && 'redirect_url' in data && data.redirect_url) {
      clearPending();
      location.assign(data.redirect_url);
      return;
    }
    const d = data as { client?: { name: string; uri?: string }; redirect_uri: string; user?: { email: string } };
    if (!d.client || !d.user) {
      clearPending();
      expired = true;
      box.innerHTML = EXPIRED;
      return;
    }
    let host = '';
    try { host = new URL(d.redirect_uri).host; } catch { /* sem endereço */ }
    box.innerHTML =
      '<div class="card aut-card"><span class="aut-ic">' + PLUG + '</span>' +
      '<span class="t">' + esc(d.client.name || 'Um app') + ' quer acessar a sua conta do Enche AI</span>' +
      '<span class="hint">Conta: <b>' + esc(d.user.email) + '</b>' + (host ? ' · volta para ' + esc(host) : '') + '</span>' +
      '<ul class="aut-list">' +
      '<li>' + ICON.check + '<span>Ver seus carros, abastecimentos e manutenções</span></li>' +
      '<li>' + ICON.check + '<span>Registrar histórico que você mandar para ele (planilhas, OS, anotações), sempre conferindo duplicados</span></li>' +
      '<li class="no">' + X + '<span>Não vê casa, trabalho, localização nem as suas avaliações de postos</span></li>' +
      '<li class="no">' + X + '<span>Não apaga nada</span></li>' +
      '</ul>' +
      '<span class="hint">Você pode desconectar a qualquer momento no Perfil.</span>' +
      '<div class="btn-row"><button type="button" class="btn" data-aut="deny"' + (busy ? ' disabled' : '') + '>Recusar</button><button type="button" class="btn primary" data-aut="ok"' + (busy ? ' disabled' : '') + '>Autorizar</button></div></div>';
  }

  $('aut-body').addEventListener('click', async (e) => {
    const a = (e.target as HTMLElement).closest<HTMLElement>('[data-aut]')?.dataset.aut;
    const id = pendingAuthorization();
    if (!a || !id || busy) return;
    busy = true;
    render();
    const res = a === 'ok'
      ? await supabase.auth.oauth.approveAuthorization(id, { skipBrowserRedirect: true })
      : await supabase.auth.oauth.denyAuthorization(id, { skipBrowserRedirect: true });
    busy = false;
    clearPending();
    if (res.error || !res.data?.redirect_url) {
      toast('Não deu para concluir: ' + (res.error?.message ?? 'resposta vazia') + '. Conecte de novo pelo Claude.');
      return render();
    }
    $('aut-body').innerHTML = '<div class="card center"><span class="ok-ic big">' + ICON.check + '</span><span class="b15">' + (a === 'ok' ? 'Conectado. Voltando para o Claude…' : 'Conexão recusada.') + '</span></div>';
    location.assign(res.data.redirect_url);
  });

  onShow('autorizar', render);
  supabase.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_IN' && pendingAuthorization()) setTimeout(() => (currentRoute().view === 'autorizar' ? render() : go('autorizar')), 300);
  });
  return { render };
}

const PLUG = '<svg aria-hidden="true" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0z"/><path d="M12 18v4"/></svg>';
const X = '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
