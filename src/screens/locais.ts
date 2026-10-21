// Casa e trabalho: base para a aba Postos comparar onde abastecer e calcular o caminho entre os dois.
import { gps, reverse, route, type FoundPlace, type Route } from '../lugares';
import { getPlaces, setPlace, type PlaceKind, type Places } from '../sync';
import { S, subscribe } from '../store';
import { $, esc, fmt, toast } from '../ui';
import { currentRoute, onShow } from '../router';
import { addressSearch, type AddressSearch } from './busca-endereco';
import { ICON } from '../icons';

const DETOURS = [500, 1000, 2000];
const TARGET = '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/><circle cx="12" cy="12" r="7"/></svg>';
const HOUSE = '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/></svg>';
const BAG = '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 13h18"/></svg>';

function place(kind: 'casa' | 'trabalho', pl: Places = S.places) {
  const p = pl[kind];
  return p && !p.deleted_at && p.lat != null && p.lon != null ? { lat: p.lat, lon: p.lon, label: p.label ?? '' } : null;
}
function rota(pl: Places = S.places): (Route & { on: boolean; detour_m: number }) | null {
  const r = pl.rota;
  if (!r || r.deleted_at) return null;
  const d = r.data as Partial<Route & { on: boolean; detour_m: number }>;
  return { pts: d.pts ?? [], km: d.km ?? 0, min: d.min ?? 0, from: d.from ?? [0, 0], to: d.to ?? [0, 0], roads: d.roads, on: !!d.on, detour_m: d.detour_m ?? 1000 };
}

export function initLocais() {
  let editing: 'casa' | 'trabalho' | null = null;
  let busy = false;
  let routeMsg = '';
  let search: AddressSearch | null = null;

  function card(k: 'casa' | 'trabalho') {
    const p = place(k);
    const head =
      '<div class="pl-head"><span class="pl-ic ' + k + '">' + (k === 'casa' ? HOUSE : BAG) + '</span><span class="mid"><span class="a">' + (k === 'casa' ? 'Casa' : 'Trabalho') + '</span><span class="b">' + (p ? esc(p.label) : 'Não cadastrado') + '</span></span>' +
      (editing === k ? '' : '<button type="button" class="btn sm" data-edit="' + k + '">' + (p ? 'Editar' : 'Cadastrar') + '</button>') + '</div>';
    if (editing !== k) return '<div class="pl-card">' + head + '</div>';
    return (
      '<div class="pl-card editing">' + head +
      '<input class="inp sm" id="l-q" placeholder="Comece a digitar a rua ou o bairro" autocomplete="off" enterkeyhint="search" aria-label="Endereço ' + (k === 'casa' ? 'de casa' : 'do trabalho') + '">' +
      '<div class="list-card" id="l-results" hidden></div>' +
      '<div class="pl-actions"><button type="button" class="link-btn" data-here="' + k + '"' + (busy ? ' disabled' : '') + '>' + TARGET + ' Usar onde estou agora</button>' +
      (p ? '<button type="button" class="link-btn muted" data-del="' + k + '">Remover</button>' : '') + '<button type="button" class="link-btn muted" data-cancel>Cancelar</button></div></div>'
    );
  }

  function render() {
    if (currentRoute().view !== 'locais') return;
    // não redesenha enquanto a pessoa digita (o texto ficaria pela metade)
    if (document.activeElement?.id === 'l-q') return;
    const r = rota();
    const both = !!(place('casa') && place('trabalho'));
    const on = !!r?.on && both;
    const det = r?.detour_m ?? 1000;
    $('l-body').innerHTML =
      card('casa') + card('trabalho') +
      '<div class="card"><div class="switch-row"><div class="t"><span>Postos no caminho</span><span>' + (both ? 'Entre casa e trabalho, sem desviar muito' : 'Cadastre casa e trabalho para ligar') + '</span></div><input type="checkbox" class="switch" role="switch" id="l-route" aria-label="Postos no caminho"' + (on ? ' checked' : '') + (both ? '' : ' disabled') + '></div>' +
      (on ? '<div class="field"><span>Desvio máximo</span><div class="chips" id="l-detour">' + DETOURS.map((d) => '<button type="button" data-detour="' + d + '" aria-selected="' + (d === det) + '">' + (d < 1000 ? d + ' m' : d / 1000 + ' km') + '</button>').join('') + '</div></div>' +
        '<span class="hint">' + esc(routeMsg || (r && r.pts.length > 1 ? 'Caminho de ' + fmt(r.km, 1) + ' km (≈ ' + r.min + ' min) calculado.' : 'Calculando o caminho…')) + '</span>' : '') + '</div>' +
      '<p class="foot-note lock">' + ICON.lock + '<span>Salvos na sua conta, só você acessa. Guardamos a rua e o ponto no mapa, sem número. Nunca entram na rede de postos.</span></p>';
    const input = document.getElementById('l-q') as HTMLInputElement | null;
    search = null;
    if (input && editing) {
      const k = editing;
      search = addressSearch(input, $('l-results'), {
        near: () => place('casa') ?? place('trabalho'),
        onPick: (p) => save(k, p),
        onBusy: (b) => (busy = b),
      });
      setTimeout(() => search?.focus(), 50);
    }
  }

  async function save(k: 'casa' | 'trabalho', x: FoundPlace) {
    await setPlace(k, { label: x.label, lat: Math.round(x.lat * 1e5) / 1e5, lon: Math.round(x.lon * 1e5) / 1e5, data: { detail: x.detail } });
    editing = k === 'casa' && !place('trabalho', await getPlaces()) ? 'trabalho' : null;
    (document.activeElement as HTMLElement | null)?.blur();
    toast((k === 'casa' ? 'Casa' : 'Trabalho') + ' salvo');
    await refreshRoute();
  }

  /** Recalcula o caminho quando casa ou trabalho mudam (e a opção está ligada). */
  async function refreshRoute(force = false) {
    const pl = await getPlaces();
    const c = place('casa', pl), t = place('trabalho', pl), r = rota(pl);
    if (!c || !t || !r?.on) return render();
    const same = r.pts.length > 1 && !!r.roads && r.from[0] === c.lat && r.from[1] === c.lon && r.to[0] === t.lat && r.to[1] === t.lon;
    if (same && !force) return render();
    routeMsg = 'Calculando o caminho…';
    render();
    try {
      const rt = await route(c, t);
      await setPlace('rota', { label: 'Casa → Trabalho', lat: null, lon: null, data: { ...rt, on: true, detour_m: r.detour_m } });
      routeMsg = '';
    } catch (e) {
      routeMsg = (e as Error).message;
    }
    render();
  }

  $('v-locais').addEventListener('click', async (e) => {
    const el = e.target as HTMLElement;
    const d = (sel: string) => el.closest<HTMLElement>(sel);
    if (d('[data-edit]')) { editing = d('[data-edit]')!.dataset.edit as 'casa'; return render(); }
    if (d('[data-cancel]')) { editing = null; (document.activeElement as HTMLElement | null)?.blur(); return render(); }
    if (d('[data-del]')) {
      const k = d('[data-del]')!.dataset.del as PlaceKind;
      await setPlace(k, null);
      editing = null;
      return toast((k === 'casa' ? 'Casa' : 'Trabalho') + ' removido');
    }
    if (d('[data-here]')) {
      const k = d('[data-here]')!.dataset.here as 'casa';
      busy = true;
      try {
        const p = await gps();
        await save(k, await reverse(p));
      } catch (err) {
        toast((err as Error).message);
      } finally {
        busy = false;
        render();
      }
      return;
    }
    if (d('[data-detour]') && d('#l-detour')) {
      const r = S.places.rota;
      if (r) await setPlace('rota', { label: r.label, lat: null, lon: null, data: { ...r.data, detour_m: Number(d('[data-detour]')!.dataset.detour) } });
    }
  });
  $('v-locais').addEventListener('change', async (e) => {
    const el = e.target as HTMLInputElement;
    if (el.id !== 'l-route') return;
    const r = S.places.rota;
    const data = { ...(r && !r.deleted_at ? r.data : {}), on: el.checked, detour_m: (r?.data as any)?.detour_m ?? 1000 };
    await setPlace('rota', { label: 'Casa → Trabalho', lat: null, lon: null, data });
    if (el.checked) refreshRoute();
  });

  subscribe(render);
  onShow('locais', () => {
    editing = place('casa') ? (place('trabalho') ? null : 'trabalho') : 'casa';
    render();
  });
  return { refreshRoute };
}
