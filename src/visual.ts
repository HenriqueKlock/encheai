// Visual do app: o clássico (atual) ou o novo (marca Enche AI: verde-mata, verde-broto, Bricolage e Instrument).
// A escolha fica no aparelho. Enquanto o novo não vira padrão, quem nunca escolheu vê o clássico e um aviso
// no Início para experimentar; dá para voltar no Perfil. O <head> do index.html aplica a classe antes de pintar.
export type Visual = 'classico' | 'novo';

const KEY = 'visual';
const DISMISS = 'visual_aviso_dispensado';

export function chosenVisual(): Visual | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'novo' || v === 'classico' ? v : null;
  } catch {
    return null;
  }
}

export const currentVisual = (): Visual => chosenVisual() ?? 'classico';
export const isNovo = () => currentVisual() === 'novo';

export function applyVisual() {
  const novo = isNovo();
  document.documentElement.classList.toggle('v2', novo);
  // barra do sistema na cor do fundo do visual escolhido
  const light = novo ? '#F2F1EA' : '#F3F4F6';
  const dark = novo ? '#0C1A15' : '#0B0D10';
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((m) => {
    m.content = /dark/.test(m.media) ? dark : light;
  });
}

export function setVisual(v: Visual) {
  try { localStorage.setItem(KEY, v); } catch { /* sem acesso */ }
  applyVisual();
}

/** O aviso do Início aparece para quem ainda não escolheu nem dispensou. */
export function showVisualNotice(): boolean {
  if (chosenVisual()) return false;
  try { return !localStorage.getItem(DISMISS); } catch { return false; }
}

export function dismissVisualNotice() {
  try { localStorage.setItem(DISMISS, '1'); } catch { /* sem acesso */ }
}

/** Logo novo: a gota. */
export const DROP = (size = 24, fill = 'currentColor') =>
  '<svg aria-hidden="true" width="' + size + '" height="' + size + '" viewBox="0 0 48 48"><path d="M24 3.5C24 3.5 9.5 19.6 9.5 29.8 9.5 37.8 16 44.3 24 44.3S38.5 37.8 38.5 29.8C38.5 19.6 24 3.5 24 3.5Z" fill="' + fill + '"/></svg>';
