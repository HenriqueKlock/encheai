// Início: onde abastecer agora (card do topo, preenchido pela aba Postos), consumo, indicadores do mês,
// próxima manutenção e o quanto você já ajudou a rede.
import { aggregate, kmPerDay } from '../calc';
import { CATALOG, computeIndicators, monthKey, monthName } from '../indicators';
import { itemStates, lastDoneByKey, progressOf, sortStates } from '../maintenance';
import { planOf } from '../plans';
import { sparkBars } from '../charts';
import { currentKmOf } from '../manut';
import { S, carIntervals, carLogs, current, subscribe } from '../store';
import type { Vehicle } from '../db';
import { $, cap, esc, fmt, km, monthYear, pl, todayISO } from '../ui';
import { currentRoute, onShow } from '../router';
import { ICON } from '../icons';
import { AFTER_OPTIONS, pendingAfter, type AfterEffect } from '../depois';
import { isNovo } from '../visual';
import { toast } from '../ui';
import { enablePush, pushState } from '../lembretes';
import { showCarStep } from './primeirocarro';

document.addEventListener('click', (e) => {
  if ((e.target as HTMLElement).closest('[data-act="car-step"]')) showCarStep();
});

export function initInicio(opts: { signedIn: () => boolean; renderRec: () => void; answerAfter: (fillId: string, v: AfterEffect) => Promise<void> }) {
  function render() {
    if (currentRoute().view !== 'inicio') return;
    const v = current();
    document.querySelectorAll<HTMLElement>('.car-name').forEach((el) => (el.textContent = v ? v.name : 'Cadastrar carro'));
    const empty = !v;
    // "Comece por aqui" fica até o primeiro registro do carro: sem carro, cadastrar; com carro, abastecer ou trazer o histórico
    const fresh = !!v && !S.logs.some((f) => f.vehicle_id === v.id && !f.deleted_at) && !S.services.some((s) => s.vehicle_id === v.id && !s.deleted_at);
    $('home-empty').hidden = !empty && !fresh;
    $('home-empty').classList.toggle('bare', empty);
    const IMPORT_HINT = '<span class="start-imp">O histórico pode vir de uma <b>planilha</b>, de <b>PDFs de manutenção</b> (com a sua IA) ou do <b>Claude</b>.</span>';
    if (empty) {
      // Sem carro, o destaque do Início é o cadastro (o atalho para Postos fica menor, logo abaixo)
      $('home-empty').innerHTML =
        '<div class="car-hero"><span class="l">Falta 1 passo</span><span class="t">Cadastre seu carro para começar</span>' +
        '<span class="s">Leva 30 segundos. Sem ele não dá para registrar abastecimentos nem calcular o consumo.</span>' +
        '<button type="button" class="btn primary block" data-act="car-step">Cadastrar carro</button>' +
        '<a class="ch-imp" href="#/importar">Já tenho histórico</a></div>';
    } else if (fresh) {
      $('home-empty').innerHTML =
        '<div class="card-head"><span>Próximo passo no ' + esc(v!.name) + '</span></div>' +
        '<p class="hint">Registre o próximo abastecimento: com dois tanques cheios o app calcula o consumo. Ou traga o que você já anotou e veja tudo agora.</p>' +
        '<div class="btn-row start-btns"><button type="button" class="btn primary" data-act="fill">Registrar abastecimento</button><a class="btn" href="#/importar">Já tenho histórico</a></div>' + IMPORT_HINT;
    }
    ['home-consumo', 'home-inds-head', 'home-inds', 'home-next'].forEach((id) => ($(id).hidden = empty));
    opts.renderRec();
    renderRede();
    renderDepois();
    renderPolicy();
    if (!v) return;
    if (isNovo()) {
      renderMes();
      $('home-next').innerHTML = nextMaintenanceRow(v);
      return;
    }
    renderConsumo();
    renderInds();
    $('home-next').innerHTML = nextMaintenanceCard(v);
  }

  /* ---------- visual novo: dois blocos do mês e a manutenção numa linha ---------- */
  function renderMes() {
    const v = current()!;
    const iv = carIntervals();
    const all = aggregate(iv);
    const today = todayISO();
    const ind = computeIndicators({ vehicleId: v.id, logs: carLogs(), services: S.services, items: S.items, today });
    const bars = iv.slice(-5);
    const min = bars.length ? Math.min(...bars.map((d) => d.kml)) * 0.85 : 0;
    const max = bars.length ? Math.max(...bars.map((d) => d.kml)) : 1;
    const spark = bars.length > 1
      ? '<span class="m2-bars" aria-hidden="true">' + bars.map((d, i) => '<i' + (i === bars.length - 1 ? ' class="on"' : '') + ' style="height:' + Math.round(30 + ((d.kml - min) / (max - min || 1)) * 70) + '%"></i>').join('') + '</span>'
      : '<span class="m2-s">' + (carLogs().length ? 'falta um tanque cheio' : 'registre o 1º tanque') + '</span>';
    // os indicadores escolhidos em Meu carro › Indicadores viram blocos; gasto e km do mês dividem um bloco
    const chosen = CATALOG.filter((c) => S.prefs.ids.includes(c.id)).map((c) => c.id);
    const g = ind.gasto_mes, k = ind.km_mes;
    const merge = chosen.includes('gasto_mes') && chosen.includes('km_mes');
    const tile = (label: string, value: string, sub: string) =>
      '<a class="m2" href="#/indicadores"><span class="m2-k">' + esc(label) + '</span><span class="m2-v' + (value.length > 9 ? ' long' : '') + '">' + esc(value) + '</span><span class="m2-s">' + esc(sub) + '</span></a>';
    const tiles = chosen.filter((id) => !(merge && id === 'km_mes')).map((id) => {
      if (id === 'gasto_mes') {
        const sub = [g.sub.startsWith('nada') ? '' : g.sub.replace(/abastecimentos?/, (m) => (m.endsWith('s') ? 'tanques' : 'tanque')), merge && k.value !== '0 km' ? k.value : ''].filter(Boolean).join(' · ') || g.sub;
        return tile('Gasto em ' + monthName(monthKey(today)), g.value.replace(/,\d\d$/, ''), sub);
      }
      const x = ind[id];
      return tile(x.name, x.value, x.sub);
    });
    $('home-consumo').innerHTML =
      '<div class="mes2">' +
      '<a class="m2" href="#/carro"><span class="m2-k">Consumo</span><span class="m2-v">' + (iv.length ? fmt(all.kml, 1) : '–') + ' <small>km/l</small></span>' + spark + '</a>' +
      tiles.join('') +
      '</div><a class="m2-edit" href="#/indicadores">Escolher indicadores</a>';
  }

  function nextMaintenanceRow(v: Vehicle): string {
    const plan = planOf(v);
    if (!plan) return '';
    const fs = carLogs();
    const curKm = currentKmOf(v, fs, S.services);
    const today = todayISO();
    const states = sortStates(itemStates(plan, lastDoneByKey(v.id, S.services, S.items), curKm, today, kmPerDay(fs)));
    const first = states.find((s) => s.status === 'vencida' || s.status === 'proxima' || s.status === 'em_dia');
    if (!first) {
      return '<a class="mn2" href="#/carro/manutencao"><span class="mn2-ic">' + ICON.wrench + '</span><span class="mn2-b"><b class="mn2-t">Manutenção</b><span class="mn2-sub">Registre a última revisão para ver a próxima troca</span></span>' + ICON.chev + '</a>';
    }
    let left = '';
    if (first.remaining_km != null) left = first.remaining_km > 0 ? 'em ' + km(first.remaining_km) + ' km' : 'passou ' + km(-first.remaining_km) + ' km';
    else if (first.remaining_days != null) left = first.remaining_days > 0 ? 'em ' + pl(first.remaining_days, 'dia', 'dias') : 'venceu';
    const pct = progressOf(first, curKm, today);
    const name = (first.item.action === 'inspecionar' ? 'Inspeção: ' : 'Troca de ') + first.item.description.toLowerCase();
    return '<a class="mn2 ' + first.status + '" href="#/carro/manutencao"><span class="mn2-ic">' + ICON.wrench + '</span><span class="mn2-b"><span class="mn2-r"><b>' + esc(cap(name)) + '</b><span>' + esc(left) + '</span></span>' +
      (pct != null ? '<span class="mn2-bar" aria-hidden="true"><i style="width:' + Math.max(4, Math.round(pct * 100)) + '%"></i></span>' : '') + '</span></a>';
  }

  function renderConsumo() {
    const iv = carIntervals();
    const all = aggregate(iv);
    const last = iv[iv.length - 1];
    $('home-consumo').innerHTML =
      '<a class="card consumo" href="#/carro"><div class="c-l"><span class="hint">Consumo médio</span><span class="c-v"><b>' + (iv.length ? fmt(all.kml, 2) : '–') + '</b><span>km/l</span></span>' +
      '<span class="hint">' + (last ? 'último tanque <b>' + fmt(last.kml, 2) + '</b>' : carLogs().length ? 'registre mais um tanque cheio' : 'registre o primeiro abastecimento') + '</span></div>' +
      '<div class="spark mini" aria-hidden="true">' + sparkBars(iv) + '</div></a>';
  }

  function renderInds() {
    const v = current()!;
    const today = todayISO();
    const ind = computeIndicators({ vehicleId: v.id, logs: carLogs(), services: S.services, items: S.items, today });
    const ordered = CATALOG.filter((c) => S.prefs.ids.includes(c.id));
    $('home-inds').hidden = !ordered.length;
    $('home-inds').innerHTML = ordered
      .map((c) => {
        const x = ind[c.id];
        return '<div class="stat"><span class="k">' + esc(x.name) + '</span><span class="v">' + esc(x.value) + '</span><span class="s">' + esc(x.sub) + '</span></div>';
      })
      .join('');
    $('h-month').textContent = ordered.length ? cap(monthName(monthKey(today))) : 'Indicadores';
  }

  function nextMaintenanceCard(v: Vehicle): string {
    const plan = planOf(v);
    const fs = carLogs();
    if (!plan) return '';
    const curKm = currentKmOf(v, fs, S.services);
    const today = todayISO();
    const states = sortStates(itemStates(plan, lastDoneByKey(v.id, S.services, S.items), curKm, today, kmPerDay(fs)));
    const dated = states.filter((s) => s.status === 'vencida' || s.status === 'proxima' || s.status === 'em_dia');
    if (!dated.length) {
      return '<a class="next-card" href="#/carro/manutencao"><div class="next-head"><div class="next-title"><span class="ic">' + ICON.wrench + '</span><span class="t"><span>Manutenção</span><span>Registre a última revisão</span></span></div></div><span class="hint">Com ela o app calcula as próximas trocas do plano ' + esc(plan.name) + '.</span></a>';
    }
    const first = dated[0];
    const group = dated.filter((s) => s.due_km === first.due_km && s.due_date === first.due_date && s.status === first.status);
    const names = group.map((s) => s.item.description);
    const title = (first.item.action === 'inspecionar' ? 'Inspeção: ' : 'Troca: ') + (names.length > 1 ? names.slice(0, -1).join(', ') + ' e ' + names[names.length - 1].toLowerCase() : names[0]);
    const pct = progressOf(first, curKm, today);
    const chip = { vencida: 'Vencida', proxima: 'Próxima', em_dia: 'Em dia' }[first.status as 'vencida'];
    let left = '';
    if (first.remaining_km != null) left = first.remaining_km > 0 ? 'Faltam <b>' + km(first.remaining_km) + ' km</b>' : 'Passou <b>' + km(-first.remaining_km) + ' km</b>';
    else if (first.remaining_days != null) left = first.remaining_days > 0 ? 'Faltam <b>' + pl(first.remaining_days, 'dia', 'dias') + '</b>' : 'Venceu há <b>' + pl(-first.remaining_days, 'dia', 'dias') + '</b>';
    const right = [first.due_km != null ? km(first.due_km) + ' km' : '', first.due_date ? 'até ' + monthYear(first.due_date) : '', first.status !== 'vencida' && first.est_date && first.due_km != null ? '≈ ' + monthYear(first.est_date) : ''].filter(Boolean).join(' · ');
    return (
      '<a class="next-card" href="#/carro/manutencao"><div class="next-head"><div class="next-title"><span class="ic">' + ICON.wrench + '</span><span class="t"><span>Próxima manutenção</span><span>' + esc(title) + '</span></span></div>' +
      '<span class="chip ' + first.status + '">' + chip + '</span></div>' +
      (pct != null ? '<div class="bar ' + first.status + '"><i style="width:' + Math.round(pct * 100) + '%"></i></div>' : '') +
      '<div class="row-meta"><span>' + left + '</span><span>' + esc(right) + '</span></div></a>'
    );
  }

  /* ---------- no dia seguinte: como o carro andou com aquele combustível? ---------- */
  const DISMISS = 'depois_dispensado';
  const dismissed = (): string[] => { try { return JSON.parse(localStorage.getItem(DISMISS) ?? '[]'); } catch { return []; } };
  function renderDepois() {
    const el = $('home-depois');
    const f = opts.signedIn() && S.prefs.contribute ? pendingAfter(S.logs, S.ratings, todayISO(), dismissed()) : null;
    if (!f) { el.innerHTML = ''; return; }
    const name = (f.station ?? 'posto').split(' · ')[0];
    const ago = Math.round((Date.parse(todayISO()) - Date.parse(f.date)) / 864e5);
    if (isNovo()) {
      // no topo do Início, em destaque: uma pergunta de um toque sobre o último abastecimento
      el.innerHTML =
        '<div class="card depois2"><span class="d2-l">Depois de abastecer · ' + esc(f.date.slice(8, 10) + '/' + f.date.slice(5, 7)) + (ago === 1 ? ' (ontem)' : ' (' + ago + ' dias)') + '</span>' +
        '<div class="d2-h"><span class="t">Como o carro andou com o combustível do ' + esc(name) + '?</span>' +
        '<button type="button" class="d2-x" data-home-dismiss="' + esc(f.id) + '" aria-label="Agora não">' + X + '</button></div>' +
        '<div class="d2-opts">' + AFTER_OPTIONS.map(([v, t]) => '<button type="button" data-home-after="' + v + '" data-fill="' + esc(f.id) + '" aria-label="' + t + '">' + AFTER_ICON[v] + AFTER_2[v] + '</button>').join('') + '</div>' +
        '<div class="d2-push" id="d2-push"></div></div>';
      void offerPush();
      return;
    }
    el.innerHTML =
      '<div class="card depois-card"><span class="l">Depois de abastecer</span><span class="t">Como o carro andou com o combustível do ' + esc(name) + '?</span>' +
      '<span class="hint">Abastecido em ' + esc(f.date.slice(8, 10) + '/' + f.date.slice(5, 7)) + ' (' + ago + ' dias atrás). Ajuda a saber a qualidade do combustível de cada posto.</span>' +
      '<div class="after-opts">' + AFTER_OPTIONS.map(([v, t]) => '<button type="button" data-home-after="' + v + '" data-fill="' + esc(f.id) + '">' + t + '</button>').join('') + '</div>' +
      '<button type="button" class="link-btn muted" data-home-dismiss="' + esc(f.id) + '">Agora não</button></div>';
  }
  /** Se o aparelho ainda não recebe o lembrete, oferece ligar ali mesmo (chega às 19h do dia seguinte). */
  async function offerPush() {
    const st = await pushState();
    const box = document.getElementById('d2-push');
    if (!box) return;
    box.innerHTML = st === 'off'
      ? '<button type="button" class="link-btn" data-push-on>' + ICON.bell + 'Me avisar no celular das próximas vezes</button>'
      : st === 'install' ? '<span class="hint">Para receber o aviso no iPhone, instale o app na tela inicial (Compartilhar › Adicionar à Tela de Início).</span>'
      : '';
  }
  $('home-depois').addEventListener('click', async (e) => {
    const el = e.target as HTMLElement;
    if (el.closest('[data-push-on]')) {
      const err = await enablePush();
      if (err) return toast(err);
      toast('Pronto: no dia seguinte a cada abastecimento chega um lembrete às 19h.');
      return void offerPush();
    }
    const a = el.closest<HTMLElement>('[data-home-after]');
    if (a) {
      a.closest('.depois-card')?.querySelectorAll('button').forEach((b) => ((b as HTMLButtonElement).disabled = true));
      await opts.answerAfter(a.dataset.fill!, a.dataset.homeAfter as AfterEffect);
      return renderDepois();
    }
    const d = el.closest<HTMLElement>('[data-home-dismiss]');
    if (d) {
      try { localStorage.setItem(DISMISS, JSON.stringify([...dismissed(), d.dataset.homeDismiss!].slice(-50))); } catch { /* sem acesso */ }
      renderDepois();
    }
  });

  /** Aviso único quando a política muda de forma relevante (transparência, LGPD). */
  const POLICY_SEEN = 'politica_vista';
  const POLICY_VERSION = '2026-10-22';
  function renderPolicy() {
    const el = $('home-policy');
    let seen = '';
    try { seen = localStorage.getItem(POLICY_SEEN) ?? ''; } catch { /* sem acesso */ }
    // quem nunca usou o app vê a política nas boas-vindas; o aviso é para quem já usava
    if (seen >= POLICY_VERSION || !S.logs.length) { el.innerHTML = ''; return; }
    el.innerHTML = '<div class="card policy-card"><span class="b15">Atualizamos a privacidade</span><span class="hint">Os números agregados da rede (médias por posto e região, sem identificar ninguém) podem ser usados em relatórios e parcerias. Nunca vendemos dados pessoais. Se preferir ficar de fora, desligue "Contribuir com a rede" no Perfil.</span>' +
      '<div class="btn-row"><a class="btn sm" href="#/privacidade">Ler a política</a><button type="button" class="btn sm primary" data-policy-ok>Entendi</button></div></div>';
  }
  const policyPending = () => { try { return (localStorage.getItem(POLICY_SEEN) ?? '') < POLICY_VERSION && S.logs.length > 0; } catch { return false; } };
  const policyOk = () => { try { localStorage.setItem(POLICY_SEEN, POLICY_VERSION); } catch { /* sem acesso */ } };
  $('home-policy').addEventListener('click', (e) => {
    if (!(e.target as HTMLElement).closest('[data-policy-ok]')) return;
    policyOk();
    $('home-policy').innerHTML = '';
  });
  // quem foi ler a política pelo aviso confirma no fim da própria página
  onShow('privacidade', () => {
    const box = $('policy-ack');
    box.innerHTML = policyPending() ? '<div class="card policy-card"><span class="hint">Leu a atualização? Confirme para o aviso sair do Início.</span><button type="button" class="btn primary" data-policy-ack>Entendi</button></div>' : '';
  });
  $('policy-ack').addEventListener('click', (e) => {
    if (!(e.target as HTMLElement).closest('[data-policy-ack]')) return;
    policyOk();
    $('policy-ack').innerHTML = '';
    location.hash = '#/inicio';
  });

  function renderRede() {
    const el = $('home-rede');
    const since = new Date(Date.parse(todayISO()) - 30 * 864e5).toISOString().slice(0, 10);
    const linked = S.logs.filter((f) => f.station_id && f.date >= since);
    const stations = new Set(linked.map((f) => f.station_id)).size;
    const unlinked = carLogs().filter((f) => !f.station_id && !f.station).length;
    const icon = '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/></svg>';
    if (!opts.signedIn()) {
      el.innerHTML = '<a class="rede-banner" href="#/perfil">' + icon + '<span>Entre na conta para ver o preço que a rede pagou e o rendimento medido de cada posto.</span></a>';
    } else if (!S.prefs.contribute) {
      el.innerHTML = '<a class="rede-banner muted" href="#/perfil">' + icon + '<span>Você vê a rede, mas não contribui. Ligue a contribuição no Perfil: só médias por posto, sem o seu nome.</span></a>';
    } else if (linked.length) {
      el.innerHTML = '<div class="rede-banner">' + icon + '<span>Seus ' + pl(linked.length, 'abastecimento', 'abastecimentos') + ' com posto nos últimos 30 dias ajudam a medir ' + pl(stations, 'posto', 'postos') + '.</span></div>';
    } else if (unlinked) {
      el.innerHTML = '<a class="rede-banner muted" href="#/carro/historico">' + icon + '<span>' + pl(unlinked, 'abastecimento seu está', 'abastecimentos seus estão') + ' sem posto. Ligar ao posto mede o rendimento dele.</span></a>';
    } else el.innerHTML = '';
  }

  subscribe(render);
  onShow('inicio', render);
  return { render };
}

const AFTER_2: Record<AfterEffect, string> = { normal: 'Normal', melhor: 'Melhor', falhou: 'Falhou', rendeu_menos: 'Rendeu −' };
const ic = (d: string, color: string) => '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="' + color + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + d + '</svg>';
const AFTER_ICON: Record<AfterEffect, string> = {
  normal: ic('<path d="M5 12l5 5 9-10"/>', 'var(--link)'),
  melhor: ic('<path d="M12 19V5M6 11l6-6 6 6"/>', 'var(--link)'),
  falhou: ic('<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17v.5"/>', 'var(--bad-ink)'),
  rendeu_menos: ic('<path d="M12 5v14M6 13l6 6 6-6"/>', 'var(--warn-icon)'),
};
const X = '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
