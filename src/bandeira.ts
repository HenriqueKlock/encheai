// Bandeira do posto como um selo redondo com as iniciais e uma cor por distribuidora (não é o logotipo
// de ninguém: só uma marca visual para reconhecer de relance). Bandeira branca aparece como "sem bandeira".
const BRANDS: Record<string, [string, string, string]> = {
  // nome na ANP: [iniciais, fundo, texto]
  Ipiranga: ['IP', '#F5BE00', '#10306B'],
  Shell: ['SH', '#F6CB1B', '#B4141E'],
  Petrobras: ['BR', '#0B8A43', '#FFE14D'],
  Rodoil: ['RO', '#1F5FA8', '#FFFFFF'],
  Ale: ['AL', '#D3262F', '#FFFFFF'],
  Stang: ['ST', '#243C8F', '#FFFFFF'],
  Maxsul: ['MX', '#C8102E', '#FFFFFF'],
  Dibrape: ['DB', '#0E63B0', '#FFFFFF'],
  Potencial: ['PT', '#E35205', '#FFFFFF'],
  Charrua: ['CH', '#7A2E1D', '#FFFFFF'],
  Idaza: ['ID', '#00796B', '#FFFFFF'],
  'Rdp Energia': ['RD', '#2E7D32', '#FFFFFF'],
  Walendowsky: ['WA', '#5D4037', '#FFFFFF'],
  Americanoil: ['AM', '#1A237E', '#FFFFFF'],
  Nexta: ['NX', '#6A1B9A', '#FFFFFF'],
};

const DROP = '<svg aria-hidden="true" viewBox="0 0 48 48"><path d="M24 6C24 6 11 20.5 11 29.7 11 36.9 16.8 42.7 24 42.7S37 36.9 37 29.7C37 20.5 24 6 24 6Z" fill="none" stroke="currentColor" stroke-width="4"/></svg>';

export const isBranca = (b: string) => !b || /branca/i.test(b);

/** Selo da bandeira; `size` em px. */
export function brandBadge(b: string, size = 22): string {
  const st = 'width:' + size + 'px;height:' + size + 'px;font-size:' + Math.round(size * 0.44) + 'px';
  if (isBranca(b)) return '<span class="bd branca" style="' + st + '" role="img" aria-label="Sem bandeira" title="Sem bandeira (bandeira branca)">' + DROP + '</span>';
  const [ini, bg, fg] = BRANDS[b] ?? [initials(b), '#5F6862', '#FFFFFF'];
  return '<span class="bd" style="' + st + ';background:' + bg + ';color:' + fg + '" role="img" aria-label="Bandeira ' + b + '" title="' + b + '">' + ini + '</span>';
}

function initials(b: string) {
  const w = b.replace(/[^\p{L}\s]/gu, '').trim().split(/\s+/).filter(Boolean);
  return ((w[0]?.[0] ?? '?') + (w[1]?.[0] ?? w[0]?.[1] ?? '')).toUpperCase();
}
