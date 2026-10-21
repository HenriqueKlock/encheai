// Navegação por endereço (#/postos, #/carro/historico…): o botão voltar do celular funciona
// e cada tela pode ser aberta direto.
export type ViewId = 'inicio' | 'postos' | 'carro' | 'perfil' | 'locais' | 'indicadores' | 'etanol' | 'privacidade';
export interface Route { view: ViewId; sub: string | null }

const TAB_OF: Record<ViewId, string> = {
  inicio: 'inicio', postos: 'postos', carro: 'carro', indicadores: 'carro', etanol: 'carro',
  perfil: 'perfil', locais: 'perfil', privacidade: 'perfil',
};
const VIEWS = Object.keys(TAB_OF) as ViewId[];

export function parse(hash = location.hash): Route {
  const [v, sub] = hash.replace(/^#\/?/, '').split('/');
  return { view: (VIEWS as string[]).includes(v) ? (v as ViewId) : 'inicio', sub: sub || null };
}

let route: Route = parse();
const handlers = new Map<ViewId, (r: Route) => void>();
export const currentRoute = () => route;

/** Chamado sempre que a tela aparece (ou muda de sub-seção). */
export function onShow(view: ViewId, fn: (r: Route) => void) {
  handlers.set(view, fn);
}

export function go(path: string, replace = false) {
  const h = '#/' + path.replace(/^#?\/?/, '');
  if (location.hash === h) return apply();
  if (replace) {
    history.replaceState(history.state, '', h);
    apply();
  } else location.hash = h;
}

function apply() {
  route = parse();
  document.querySelectorAll<HTMLElement>('main > .view').forEach((s) => (s.hidden = s.id !== 'v-' + route.view));
  const tab = TAB_OF[route.view];
  document.querySelectorAll<HTMLElement>('.tab').forEach((t) => {
    if (t.dataset.tab === tab) t.setAttribute('aria-current', 'page');
    else t.removeAttribute('aria-current');
  });
  window.scrollTo(0, 0);
  handlers.get(route.view)?.(route);
}

export function startRouter() {
  window.addEventListener('hashchange', apply);
  apply();
}
