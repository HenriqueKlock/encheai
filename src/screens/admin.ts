// Painel do app (só administradores): uso agregado — funil do primeiro acesso, aparelhos por dia, telas,
// plataformas e caminhos mais comuns. Os números vêm prontos do banco (admin_uso); nada individual chega aqui.
import { supabase } from '../sync';
import { onShow } from '../router';
import { $, esc } from '../ui';
import { markAdminDevice } from '../uso';

type Uso = {
  dias: number; aparelhos: number; aberturas: number; eventos: number; pularam_carro: number;
  funil: { ev: string; n: number }[];
  diario: { d: string; aparelhos: number; aberturas: number }[];
  telas: { view: string; aberturas: number }[];
  plataformas: { plat: string; aparelhos: number }[];
  caminhos: { c: string; n: number }[];
};

const PASSO: Record<string, string> = {
  open: 'Abriu o app', welcome: 'Viu as boas-vindas', login_link: 'Pediu o link de acesso', login_ok: 'Entrou na conta',
  car_step: 'Viu a etapa do carro', car_created: 'Cadastrou carro', fill_open: 'Abriu Abastecer', fill_saved: 'Salvou abastecimento',
};
const TELA: Record<string, string> = {
  inicio: 'Início', postos: 'Postos', carro: 'Meu carro', perfil: 'Perfil', locais: 'Casa e trabalho', indicadores: 'Indicadores',
  etanol: 'Etanol', privacidade: 'Privacidade', importar: 'Trazer histórico', autorizar: 'Autorizar app', admin: 'Painel',
};
const nomeTela = (v: string) => TELA[v] ?? v;

let cache: boolean | null = null;
/** É administrador? (consulta uma vez por abertura do app) */
export async function souAdmin() {
  if (cache !== null) return cache;
  const { data, error } = await supabase.rpc('sou_admin');
  cache = !error && data === true;
  if (cache) markAdminDevice();
  return cache;
}

export function initAdmin() {
  let dias = 14;
  const bars = (rows: { label: string; n: number; sub?: string }[], max = Math.max(1, ...rows.map((r) => r.n))) =>
    rows.map((r) =>
      '<div class="adm-bar"><span class="adm-l">' + esc(r.label) + (r.sub ? ' <em>' + esc(r.sub) + '</em>' : '') + '</span>' +
      '<span class="adm-t"><i style="width:' + Math.round((r.n / max) * 100) + '%"></i></span><b>' + r.n + '</b></div>').join('');

  async function render() {
    const el = $('adm-body');
    el.innerHTML = '<p class="hint">Carregando…</p>';
    const { data, error } = await supabase.rpc('admin_uso', { dias });
    if (error) {
      el.innerHTML = '<div class="card"><p class="hint">' + (/administradores/.test(error.message) ? 'Este painel é só para administradores do app.' : 'Não consegui carregar: ' + esc(error.message)) + '</p></div>';
      return;
    }
    const u = data as Uso;
    const top = u.funil[0]?.n || 1;
    const funil = u.funil.map((f) => ({ label: PASSO[f.ev] ?? f.ev, n: f.n, sub: Math.round((f.n / top) * 100) + '%' }));
    el.innerHTML =
      '<div class="adm-kpis">' +
      [['Aparelhos', u.aparelhos], ['Aberturas', u.aberturas], ['Pularam o carro', u.pularam_carro]].map(([l, n]) => '<div class="card adm-k"><b>' + n + '</b><span>' + l + '</span></div>').join('') +
      '</div>' +
      '<div class="card"><div class="card-head"><span>Funil do primeiro acesso</span></div><p class="hint">Aparelhos que passaram por cada passo no período.</p>' + bars(funil, top) + '</div>' +
      '<div class="card"><div class="card-head"><span>Aparelhos por dia</span></div>' +
      (u.diario.length ? bars(u.diario.map((d) => ({ label: d.d.slice(8, 10) + '/' + d.d.slice(5, 7), n: d.aparelhos, sub: d.aberturas + ' aberturas' }))) : '<p class="hint">Sem dados ainda.</p>') + '</div>' +
      '<div class="card"><div class="card-head"><span>Telas</span></div><p class="hint">Em quantas aberturas do app cada tela apareceu.</p>' +
      bars(u.telas.map((t) => ({ label: nomeTela(t.view), n: t.aberturas }))) + '</div>' +
      '<div class="card"><div class="card-head"><span>Caminhos mais comuns</span></div><p class="hint">As 4 primeiras telas de cada abertura.</p>' +
      (u.caminhos.length ? bars(u.caminhos.map((c) => ({ label: c.c.split(' → ').map(nomeTela).join(' → '), n: c.n }))) : '<p class="hint">Sem dados ainda.</p>') + '</div>' +
      '<div class="card"><div class="card-head"><span>Plataformas</span></div>' + bars(u.plataformas.map((p) => ({ label: p.plat, n: p.aparelhos }))) + '</div>' +
      '<p class="hint">Medição pseudônima desde 23/10/2026: sem conta, e-mail ou localização. Eventos brutos somem em 90 dias.</p>';
  }

  $('adm-dias').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-d]');
    if (!b) return;
    dias = Number(b.dataset.d);
    $('adm-dias').querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    render();
  });
  onShow('admin', render);
}
