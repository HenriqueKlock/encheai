// Perfil: conta e sincronização, contribuição com a rede, casa e trabalho, carros,
// dados (trazer do app anterior, backup, baixar), privacidade e exclusão da conta.
import { db, setMeta } from '../db';
import { exportBackup, importBackup, legacyData, type LegacyData } from '../backup';
import { TERMS_VERSION } from '../config';
import { currentSession, deleteAccount, setContribute, setPlace, signOut, sync, type PlaceKind, type SyncStatus } from '../sync';
import { S, activeVehicles, current, subscribe } from '../store';
import { $, closeSheets, esc, openSheet, pl, todayISO, toast } from '../ui';
import { currentRoute, onShow } from '../router';
import { renderLogin } from './conta';
import { ICON } from '../icons';
import { canInstall, install, isStandalone, onInstallChange } from '../instalar';

declare const __BUILD__: string;

export function initPerfil(opts: { status: () => SyncStatus; statusText: () => string }) {
  let email: string | null = null;
  let legacy: LegacyData | null = null;
  let legacyChecked = false;

  async function refreshSession() {
    email = (await currentSession())?.user.email ?? null;
  }

  async function checkLegacy() {
    legacyChecked = true;
    legacy = await legacyData();
    render();
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
          : '<span class="hint">Desligado: você continua vendo a rede, mas seus abastecimentos não entram nas médias.</span>') + '</div>'
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

    const data =
      '<div class="list-card">' +
      (legacy ? '<button type="button" class="row simple" data-p="legacy"><span class="mid"><span class="a">Trazer meus dados do app anterior</span><span class="b">' + pl(legacy.counts.vehicles, 'carro', 'carros') + ', ' + pl(legacy.counts.fuel_logs, 'abastecimento', 'abastecimentos') + ', ' + pl(legacy.counts.services, 'manutenção', 'manutenções') + ' neste celular</span></span><span></span><span class="chev">' + ICON.chev + '</span></button>' : '') +
      '<button type="button" class="row simple" data-p="export"><span class="mid"><span class="a">Baixar meus dados</span><span class="b">Arquivo JSON com carros e registros</span></span><span></span><span class="chev">' + ICON.chev + '</span></button>' +
      '<button type="button" class="row simple" data-act="import"><span class="mid"><span class="a">Importar backup</span><span class="b">Junta com o que já existe; não apaga nada</span></span><span></span><span class="chev">' + ICON.chev + '</span></button>' +
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
    if (!legacyChecked) checkLegacy();
  }

  $('perfil-body').addEventListener('change', async (e) => {
    const el = e.target as HTMLInputElement;
    if (el.id !== 'p-contribute') return;
    await setContribute(el.checked, TERMS_VERSION);
    toast(el.checked ? 'Obrigado! Seus abastecimentos com posto entram nas médias da rede.' : 'Contribuição desligada. Em até 15 minutos seus dados deixam de contar.');
  });
  $('perfil-body').addEventListener('click', async (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-p]');
    if (!b) return;
    const p = b.dataset.p;
    if (p === 'sync') { await sync(); return render(); }
    if (p === 'out') { await signOut(); toast('Você saiu. Os dados continuam neste aparelho.'); return render(); }
    if (p === 'export') return download();
    if (p === 'install') { if (await install()) toast('Instalado! Procure o Enche Aí na tela inicial.'); return render(); }
    if (p === 'legacy') return importLegacy();
    if (p === 'delete') {
      $<HTMLInputElement>('del-confirm').value = '';
      $<HTMLButtonElement>('del-go').disabled = true;
      $('del-err').hidden = true;
      openSheet('del-sheet');
    }
  });

  async function download() {
    const data = await exportBackup();
    const blob = new Blob([JSON.stringify({ ...data, places: S.places, ratings: S.ratings }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'encheai-meus-dados-' + todayISO() + '.json';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    toast('Arquivo baixado');
  }

  async function importLegacy() {
    const d = legacy ?? (await legacyData());
    if (!d) return toast('Não encontrei dados do app anterior neste celular.');
    const res = await importBackup(d.backup);
    for (const k of ['casa', 'trabalho', 'rota'] as PlaceKind[]) {
      const p = d.places[k];
      if (p && !p.deleted_at && !S.places[k]) await setPlace(k, { label: p.label, lat: p.lat, lon: p.lon, data: p.data ?? {} });
    }
    if (!current()) {
      const first = (await db.vehicles.toArray()).find((v) => !v.archived && !v.deleted_at);
      if (first) await setMeta('current_vehicle', first.id);
    }
    toast('Trazido: ' + pl(res.vehicles, 'carro', 'carros') + ', ' + pl(res.fuel_logs, 'abastecimento', 'abastecimentos') + ', ' + pl(res.services, 'manutenção', 'manutenções'));
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
  return { render, importLegacy, legacyInfo: () => legacy, checkLegacy };
}

const PIN = '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>';
