// Visual novo, aba Postos: a lista é uma folha sobre o mapa em tela cheia. Arrastar pela alça leva a folha
// para cima (lista inteira), para o meio ou para baixo (mapa quase inteiro). Tocar na alça alterna meio e baixo.
import { isNovo } from './visual';

type Pos = 'aberta' | 'meio' | 'baixa';

export function initFolha(sheet: HTMLElement, grab: HTMLElement, body: HTMLElement, onMove?: () => void) {
  let pos: Pos = 'meio';
  const safeTop = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sat')) || 0;
  const tabbarH = () => document.getElementById('tabbar')?.getBoundingClientRect().height ?? 80;
  /** Posição do topo da folha (px a partir do topo da tela) em cada estado. */
  function topOf(p: Pos) {
    const h = window.innerHeight;
    if (p === 'aberta') return 66 + safeTop();
    if (p === 'baixa') return h - tabbarH() - 100; // alça e filtros à vista, acima do botão Abastecer
    return Math.round(h * 0.5);
  }
  function apply(p: Pos) {
    pos = p;
    if (p !== 'aberta') body.scrollTop = 0;
    sheet.style.setProperty('--sheet-top', topOf(p) + 'px');
    sheet.dataset.pos = p;
    grab.setAttribute('aria-label', p === 'baixa' ? 'Mostrar a lista de postos' : 'Esconder a lista e ver o mapa');
    setTimeout(() => onMove?.(), 300);
  }

  let startY = 0, startTop = 0, lastY = 0, lastT = 0, vel = 0, moved = false, dragging = false;
  grab.addEventListener('pointerdown', (e) => {
    if (!isNovo()) return;
    dragging = true;
    moved = false;
    startY = lastY = e.clientY;
    lastT = performance.now();
    vel = 0;
    startTop = sheet.getBoundingClientRect().top;
    sheet.classList.add('dragging');
    grab.setPointerCapture(e.pointerId);
  });
  grab.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dy = e.clientY - startY;
    if (Math.abs(dy) > 6) moved = true;
    const now = performance.now();
    vel = (e.clientY - lastY) / Math.max(1, now - lastT); // px/ms, positivo = descendo
    lastY = e.clientY;
    lastT = now;
    const top = Math.min(topOf('baixa'), Math.max(topOf('aberta'), startTop + dy));
    sheet.style.setProperty('--sheet-top', top + 'px');
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    sheet.classList.remove('dragging');
    if (!moved) return apply(pos === 'baixa' ? 'meio' : pos === 'aberta' ? 'meio' : 'baixa');
    const top = sheet.getBoundingClientRect().top;
    // um gesto rápido vai para o próximo estado na direção dele; devagar, para o mais perto
    const order: Pos[] = ['aberta', 'meio', 'baixa'];
    if (Math.abs(vel) > 0.5) {
      const cur = order.reduce((a, b) => (Math.abs(topOf(b) - top) < Math.abs(topOf(a) - top) ? b : a));
      const i = order.indexOf(cur);
      const goingDown = vel > 0;
      const next = goingDown ? (topOf(cur) >= top ? cur : order[Math.min(2, i + 1)]) : (topOf(cur) <= top ? cur : order[Math.max(0, i - 1)]);
      return apply(next);
    }
    apply(order.reduce((a, b) => (Math.abs(topOf(b) - top) < Math.abs(topOf(a) - top) ? b : a)));
  };
  grab.addEventListener('pointerup', end);
  grab.addEventListener('pointercancel', end);
  grab.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp') { e.preventDefault(); apply(pos === 'baixa' ? 'meio' : 'aberta'); }
    if (e.key === 'ArrowDown') { e.preventDefault(); apply(pos === 'aberta' ? 'meio' : 'baixa'); }
  });

  // rolar a lista com a folha no meio abre a folha inteira (como nos apps de mapa)
  body.addEventListener('scroll', () => {
    if (isNovo() && pos !== 'aberta' && body.scrollTop > 24) apply('aberta');
  }, { passive: true });
  window.addEventListener('resize', () => apply(pos));

  apply('meio');
  return {
    /** Quanto da altura da tela a folha cobre agora (para o mapa enquadrar os postos na parte visível). */
    cover: () => (isNovo() ? Math.max(0, window.innerHeight - sheet.getBoundingClientRect().top) : 0),
    set: apply,
    get: () => pos,
  };
}
