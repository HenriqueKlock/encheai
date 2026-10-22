// Visual novo, aba Postos: a lista é uma folha sobre o mapa em tela cheia, com três posições
// (aberta: lista inteira; meio; baixa: mapa quase inteiro).
// - Arrastar em qualquer parte da folha a move junto com o dedo. Na lista, enquanto a folha não está aberta,
//   arrastar para cima sobe a folha (em vez de rolar a lista); com a folha aberta e a lista no topo,
//   puxar para baixo desce a folha e mostra o mapa.
// - Tocar na alça alterna meio e baixa. No computador, arrasta pela alça com o mouse.
import { isNovo } from './visual';

type Pos = 'aberta' | 'meio' | 'baixa';
const ORDER: Pos[] = ['aberta', 'meio', 'baixa'];

export function initFolha(sheet: HTMLElement, grab: HTMLElement, body: HTMLElement, onSettle?: (p: Pos) => void) {
  let pos: Pos = 'meio';
  const safeTop = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sat')) || 0;
  const tabbarH = () => document.getElementById('tabbar')?.getBoundingClientRect().height || 80;
  /** Topo da folha (px a partir do topo da tela) em cada posição. */
  function topOf(p: Pos) {
    const h = window.innerHeight;
    if (p === 'aberta') return 66 + safeTop();
    if (p === 'baixa') return h - tabbarH() - 100; // alça e filtros à vista, acima do botão Abastecer
    return Math.round(h * 0.5);
  }
  const nearest = (top: number) => ORDER.reduce((a, b) => (Math.abs(topOf(b) - top) < Math.abs(topOf(a) - top) ? b : a));
  let settleTimer: number | undefined;
  function apply(p: Pos, notify = true) {
    const changed = p !== pos;
    pos = p;
    sheet.style.setProperty('--sheet-top', topOf(p) + 'px');
    sheet.dataset.pos = p;
    if (p !== 'aberta') body.scrollTop = 0;
    grab.setAttribute('aria-label', p === 'baixa' ? 'Mostrar a lista de postos' : 'Esconder a lista e ver o mapa');
    clearTimeout(settleTimer);
    // espera a animação acabar para o mapa reenquadrar na parte que ficou visível
    if (notify && changed) settleTimer = window.setTimeout(() => onSettle?.(p), 300);
  }
  const curTop = () => sheet.getBoundingClientRect().top;
  /** Solta a folha: gesto rápido vai para a próxima posição na direção dele; devagar, para a mais perto. */
  function release(vel: number) {
    const top = curTop();
    if (Math.abs(vel) > 0.45) {
      const next = vel > 0 ? ORDER.find((p) => topOf(p) > top + 8) ?? 'baixa' : [...ORDER].reverse().find((p) => topOf(p) < top - 8) ?? 'aberta';
      return apply(next);
    }
    apply(nearest(top));
  }

  /* ---------- toque (celular) ---------- */
  type Drag = { y0: number; x0: number; top0: number; lastY: number; lastT: number; vel: number; mode: 'undecided' | 'sheet' | 'native'; inBody: boolean };
  let d: Drag | null = null;
  sheet.addEventListener('touchstart', (e) => {
    if (!isNovo() || e.touches.length !== 1) return;
    const t = e.touches[0];
    d = { y0: t.clientY, x0: t.clientX, top0: curTop(), lastY: t.clientY, lastT: performance.now(), vel: 0, mode: 'undecided', inBody: body.contains(e.target as Node) };
  }, { passive: true });
  sheet.addEventListener('touchmove', (e) => {
    if (!d) return;
    const t = e.touches[0];
    const dy = t.clientY - d.y0, dx = t.clientX - d.x0;
    if (d.mode === 'undecided') {
      if (Math.abs(dy) < 5 && Math.abs(dx) < 5) return;
      if (Math.abs(dx) > Math.abs(dy)) d.mode = 'native'; // chips rolando de lado
      else if (!d.inBody || pos !== 'aberta') d.mode = 'sheet';
      else d.mode = dy > 0 && body.scrollTop <= 0 ? 'sheet' : 'native';
      if (d.mode === 'sheet') {
        sheet.classList.add('dragging');
        d.y0 = d.lastY = t.clientY; // conta a partir daqui: a folha não dá salto
        d.top0 = curTop();
      }
    }
    if (d.mode !== 'sheet') return;
    e.preventDefault();
    const now = performance.now();
    d.vel = 0.7 * ((t.clientY - d.lastY) / Math.max(1, now - d.lastT)) + 0.3 * d.vel;
    d.lastY = t.clientY;
    d.lastT = now;
    sheet.style.setProperty('--sheet-top', Math.min(topOf('baixa'), Math.max(topOf('aberta'), d.top0 + (t.clientY - d.y0))) + 'px');
  }, { passive: false });
  const touchEnd = () => {
    if (!d) return;
    const was = d;
    d = null;
    if (was.mode !== 'sheet') return;
    sheet.classList.remove('dragging');
    release(performance.now() - was.lastT > 120 ? 0 : was.vel);
  };
  sheet.addEventListener('touchend', touchEnd);
  sheet.addEventListener('touchcancel', touchEnd);

  /* ---------- alça com o mouse ---------- */
  let m: { y0: number; top0: number; lastY: number; lastT: number; vel: number; moved: boolean } | null = null;
  let suppressClick = false;
  grab.addEventListener('pointerdown', (e) => {
    if (!isNovo() || e.pointerType === 'touch') return;
    m = { y0: e.clientY, top0: curTop(), lastY: e.clientY, lastT: performance.now(), vel: 0, moved: false };
    sheet.classList.add('dragging');
    grab.setPointerCapture(e.pointerId);
  });
  grab.addEventListener('pointermove', (e) => {
    if (!m) return;
    const dy = e.clientY - m.y0;
    if (Math.abs(dy) > 5) m.moved = true;
    const now = performance.now();
    m.vel = (e.clientY - m.lastY) / Math.max(1, now - m.lastT);
    m.lastY = e.clientY;
    m.lastT = now;
    sheet.style.setProperty('--sheet-top', Math.min(topOf('baixa'), Math.max(topOf('aberta'), m.top0 + dy)) + 'px');
  });
  const pointerEnd = () => {
    if (!m) return;
    const was = m;
    m = null;
    sheet.classList.remove('dragging');
    if (was.moved) {
      suppressClick = true;
      release(performance.now() - was.lastT > 120 ? 0 : was.vel);
    }
  };
  grab.addEventListener('pointerup', pointerEnd);
  grab.addEventListener('pointercancel', pointerEnd);
  // toque simples (ou Enter) na alça: meio ↔ baixa; da aberta volta ao meio
  grab.addEventListener('click', () => {
    if (suppressClick) { suppressClick = false; return; }
    if (isNovo()) apply(pos === 'meio' ? 'baixa' : 'meio');
  });
  grab.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp') { e.preventDefault(); apply(pos === 'baixa' ? 'meio' : 'aberta'); }
    if (e.key === 'ArrowDown') { e.preventDefault(); apply(pos === 'aberta' ? 'meio' : 'baixa'); }
  });
  window.addEventListener('resize', () => apply(pos, false));

  apply('meio', false);
  return {
    /** Quanto da altura da tela a folha cobre agora (para o mapa enquadrar os postos na parte visível). */
    cover: () => (isNovo() ? Math.max(0, window.innerHeight - curTop()) : 0),
    set: (p: Pos) => apply(p),
    get: () => pos,
  };
}
