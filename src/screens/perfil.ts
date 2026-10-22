// Perfil: conta e sincronização, contribuição com a rede, casa e trabalho, carros,
// dados (backup, baixar), privacidade e exclusão da conta.
import { db, setMeta } from '../db';
import { exportBackup } from '../backup';
import { TERMS_VERSION } from '../config';
import { currentSession, deleteAccount, setContribute, setPlace, signOut, supabase, sync, type PlaceKind, type SyncStatus } from '../sync';
import { S, activeVehicles, current, subscribe } from '../store';
import { $, closeSheets, esc, openSheet, pl, todayISO, toast } from '../ui';
import { currentRoute, onShow } from '../router';
import { renderLogin } from './conta';
import { ICON } from '../icons';
import { canInstall, install, isStandalone, onInstallChange } from '../instalar';
import { disablePush, enablePush, pushState, type PushState } from '../lembretes';

declare const __BUILD__: string;

export function initPerfil(opts: { status: () => SyncStatus; statusText: () => string }) {
  let email: string | null = null;
  // apps conectados pelo OAuth (o Claude, pelo conector)
  let grants: { id: string; name: string; at: string }[] = [];
  let grantsFor: string | null = null;
  let push: PushState | null = null;
  async function loadPush() {
    push = await pushState();
    render();
  }
  async function loadGrants() {
    grantsFor = email;
    try {
      const { data, error } = await supabase.auth.oauth.listGrants();
      grants = error || !data ? [] : data.map((g) => ({ id: g.client.id, name: g.client.name || 'App', at: g.granted_at }));
    } catch {
      grants = [];
    }
    if (grants.length) render();
  }

  async function refreshSession() {
    email = (await currentSession())?.user.email ?? null;
  }

  function pushCard() {
    if (push === null) { loadPush(); return ''; }
    const hint = !S.prefs.contribute
      ? 'Ligue "Contribuir com a rede" para receber.'
      : push === 'install' ? 'No iPhone, instale o app na tela inicial primeiro (Compartilhar › Adicionar à Tela de Início).'
      : push === 'unsupported' ? 'Este navegador não recebe notificações.'
      : push === 'blocked' ? 'As notificações estão bloqueadas para o app. Libere nas configurações do navegador.'
      : 'No dia seguinte ao abastecimento, às 19h, uma notificação pergunta como o carro andou com aquele combustível.';
    const can = S.prefs.contribute && (push === 'on' || push === 'off');
    return '<div class="card"><div class="switch-row"><div class="t"><span>Lembrete do combustível</span><span>' + esc(hint) + '</span></div>' +
      '<input type="checkbox" class="switch" role="switch" id="p-push" aria-label="Lembrete do combustível"' + (push === 'on' ? ' checked' : '') + (can ? '' : ' disabled') + '></div></div>';
  }

  async function render() {
    if (currentRoute().view !== 'perfil') return;
    // não redesenha enquanto a pessoa digita o e-mail ou o código
    const a = document.activeElement;
    if (a instanceof HTMLInputElement && a.type !== 'checkbox' && $('perfil-body').contains(a)) return;
    await refreshSession();
    const body = $('perfil-body');
    const cars = activeVehicles().map((c) => c.name).join(' · ') || 'Nenhum cadastrado';
    const pls = [S.places.casa, S.places.trabalho].filter((p) => p && !p.deleted_at);
    const since = new Date(Date.parse(todayISO()) - 180 * 864e5).toISOString().slice(0, 10);
    const linked = S.logs.filter((f) => f.station_id && f.date >= since);
    const rated = Object.values(S.ratings).length;
    const stations = new Set(linked.map((f) => f.station_id)).size;
    const st = opts.status();
    const statusLine = st.kind === 'error' ? st.message : opts.statusText();

    const account = email
      ? '<div class="card acct"><div class="acct-h"><span class="avatar">' + esc(email[0].toUpperCase()) + '</span><span class="mid"><span class="a">' + esc(email) + '</span><span class="b' + (st.kind === 'error' ? ' bad' : '') + '">' + esc(statusLine) + '</span></span><button type="button" class="link-btn" data-p="sync">Sincronizar</button></div></div>' +
        '<div class="card"><div class="switch-row"><div class="t"><span>Contribuir com a rede</span><span>Só médias por posto, sem o seu nome</span></div><input type="checkbox" class="switch" role="switch" id="p-contribute" aria-label="Contribuir com a rede"' + (S.prefs.contribute ? ' checked' : '') + '></div>' +
        (S.prefs.contribute
          ? '<div class="contrib"><div><b>' + linked.length + '</b><span>abastecimentos com posto (6 meses)</span></div><div><b>' + rated + '</b><span>' + (rated === 1 ? 'avaliação' : 'avaliações') + '</span></div><div><b>' + stations + '</b><span>' + (stations === 1 ? 'posto que você ajuda a medir' : 'postos que você ajuda a medir') + '</span></div></div>'
          : '<span class="hint">Desligado: você continua vendo a rede, mas seus abastecimentos não entram nas médias.</span>') + '</div>' +
        pushCard()
      : '<div class="card" id="p-login"></div>';

    const inst = canInstall() && !isStandalone()
      ? '<div class="list-card"><button type="button" class="row simple" data-p="install"><span class="mid"><span class="a">Instalar o Enche Aí</span><span class="b">Abre direto da tela inicial, como um app</span></span><span></span><span class="chev">' + ICON.chev + '</span></button></div>'
      : '';
    const nav =
      inst +
      '<div class="list-card">' +
      '<a class="row nav" href="#/locais"><span class="ic gray">' + PIN + '</span><span class="mid"><span class="a">Casa e trabalho</span><span class="b">' + (pls.length ? esc(pls.map((p) => p!.label).join(' · ')) : 'Base para comparar postos') + '</span></span><span class="chev">' + ICON.chev + '</span></a>' +
      '<button type="button" class="row nav" data-act="cars"><span class="ic gray">' + activeVehicles().length + '</span><span class="mid"><span class="a">Carros</span><span class="b">' + esc(cars) + '</span></span><span class="chev">' + ICON.chev + '</span></button>' +
      '<a class="row nav" href="#/indicadores"><span class="ic blue">' + ICON.chart + '</span><span class="mid"><span class="a">Indicadores</span><span class="b">O que aparece no início</span></span><span class="chev">' + ICON.chev + '</span></a>' +
      '</div>';

    if (email && grantsFor !== email) loadGrants();
    const apps = email && grants.length
      ? '<div class="sec-head"><span>Apps conectados</span></div><div class="list-card">' + grants.map((g) =>
          '<div class="row simple conn-row"><span class="mid"><span class="a">' + esc(g.name) + '</span><span class="b">Conectado em ' + esc(g.at.slice(8, 10) + '/' + g.at.slice(5, 7) + '/' + g.at.slice(0, 4)) + ' · vê e registra carros e histórico</span></span><button type="button" class="btn sm" data-revoke="' + esc(g.id) + '">Desconectar</button></div>').join('') + '</div>'
      : '';
    const data =
      apps +
      '<div class="list-card">' +
      '<button type="button" class="row simple" data-p="export"><span class="mid"><span class="a">Baixar meus dados</span><span class="b">Arquivo JSON com carros e registros</span></span><span></span><span class="chev">' + ICON.chev + '</span></button>' +
      '<a class="row simple" href="#/importar"><span class="mid"><span class="a">Trazer histórico</span><span class="b">Planilha, a sua IA, o Claude ou um backup; confere antes de gravar</span></span><span></span><span class="chev">' + ICON.chev + '</span></a>' +
      '<button type="button" class="row simple" data-act="relato"><span class="mid"><span class="a">Relatar problema ou sugestão</span><span class="b">Vai direto para quem faz o app</span></span><span></span><span class="chev">' + ICON.chev + '</span></button>' +
      '<a class="row simple" href="#/privacidade"><span class="mid"><span class="a">Privacidade e termos</span><span class="b">O que guardamos e o que a rede mostra</span></span><span></span><span class="chev">' + ICON.chev + '</span></a>' +
      (email ? '<button type="button" class="row simple" data-p="out"><span class="mid"><span class="a">Sair desta conta</span><span class="b">Os dados continuam neste aparelho</span></span><span></span><span class="chev">' + ICON.chev + '</span></button>' : '') +
      '</div>';

    const danger = email
      ? '<button type="button" class="danger-card" data-p="delete"><span class="a">Excluir conta e todos os dados</span><span class="b">Apaga carros, abastecimentos, OS, locais e avaliações</span></button>'
      : '';

    let persisted = false;
    try { persisted = (await navigator.storage?.persisted?.()) ?? false; } catch { /* sem suporte */ }
    const device =
      '<p class="foot-note">Neste aparelho: ' + pl(S.vehicles.length, 'carro', 'carros') + ' · ' + pl(S.logs.length, 'abastecimento', 'abastecimentos') + ' · ' + pl(S.services.length, 'manutenção', 'manutenções') +
      (persisted ? ' · armazenamento protegido' : '') + ' · versão ' + esc(__BUILD__) + '</p>';

    body.innerHTML = account + nav + data + danger + device;
    if (!email) renderLogin($('p-login'));
  }

  $('perfil-body').addEventListener('change', async (e) => {
    const el = e.target as HTMLInputElement;
    if (el.id === 'p-push') {
      el.disabled = true;
      if (el.checked) {
        const err = await enablePush();
        if (err) toast(err);
        else toast('Pronto: no dia seguinte a cada abastecimento chega um lembrete às 19h.');
      } else {
        await disablePush();
        toast('Lembretes desligados neste aparelho.');
      }
      return loadPush();
    }
    if (el.id !== 'p-contribute') return;
    await setContribute(el.checked, TERMS_VERSION);
    toast(el.checked ? 'Obrigado! Seus abastecimentos com posto entram nas médias da rede.' : 'Contribuição desligada. Em até 15 minutos seus dados deixam de contar.');
  });
  $('perfil-body').addEventListener('click', async (e) => {
    const rv = (e.target as HTMLElement).closest<HTMLElement>('[data-revoke]');
    if (rv) {
      const { error } = await supabase.auth.oauth.revokeGrant({ clientId: rv.dataset.revoke! });
      if (error) return toast('Não deu para desconectar agora. Tente de novo.');
      grants = grants.filter((g) => g.id !== rv.dataset.revoke);
      toast('Desconectado. O app perde o acesso à sua conta.');
      return render();
    }
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-p]');
    if (!b) return;
    const p = b.dataset.p;
    if (p === 'sync') { await sync(); return render(); }
    if (p === 'out') { await disablePush(); push = null; await signOut(); toast('Você saiu. Os dados continuam neste aparelho.'); return render(); }
    if (p === 'export') return download();
    if (p === 'install') { if (await install()) toast('Instalado! Procure o Enche Aí na tela inicial.'); return render(); }
    if (p === 'delete') {
      $<HTMLInputElement>('del-confirm').value = '';
      $<HTMLButtonElement>('del-go').disabled = true;
      $('del-err').hidden = true;
      openSheet('del-sheet');
    }
  });

  async function download() {
    const data = await exportBackup();
    // o que só existe no servidor também vai junto: preços informados e o lembrete deste aparelho
    let servidor: Record<string, unknown> = {};
    if (await currentSession()) {
      const [pr, ps] = await Promise.all([
        supabase.from('price_reports').select('station_id, fuel, day, price, created_at'),
        supabase.from('push_subscriptions').select('endpoint, created_at'),
      ]);
      servidor = { precos_informados: pr.data ?? [], lembretes: ps.data ?? [] };
    }
    const blob = new Blob([JSON.stringify({ ...data, places: S.places, ratings: S.ratings, prefs: S.prefs, ...servidor }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'encheai-meus-dados-' + todayISO() + '.json';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    toast('Arquivo baixado');
  }


  // excluir conta
  $('del-confirm').addEventListener('input', () => {
    $<HTMLButtonElement>('del-go').disabled = $<HTMLInputElement>('del-confirm').value.trim().toUpperCase() !== 'EXCLUIR';
  });
  $('del-go').addEventListener('click', async () => {
    const btn = $<HTMLButtonElement>('del-go');
    btn.disabled = true;
    btn.textContent = 'Excluindo…';
    try {
      await deleteAccount();
      closeSheets();
      toast('Conta e dados excluídos.');
      setTimeout(() => location.replace(location.pathname), 900);
    } catch (err) {
      $('del-err').textContent = (err as Error).message;
      $('del-err').hidden = false;
      btn.disabled = false;
      btn.textContent = 'Excluir tudo';
    }
  });

  subscribe(render);
  onInstallChange(render);
  onShow('perfil', () => render());
  return { render };
}

const PIN = '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>';
