// Campo de endereço com sugestões enquanto digita: Google quando disponível (logado e com chave),
// senão OpenStreetMap (Photon). Enter sem sugestões busca no Nominatim.
// Cada campo tem o próprio estado: o texto de um nunca aparece no outro.
import { newSession, placeDetails, searchAddress, suggestAddress, suggestOSM, type FoundPlace } from '../lugares';
import type { LatLon } from '../postos';
import { esc, toast } from '../ui';
import { ICON } from '../icons';

export interface AddressSearch { focus(): void; clear(): void }

type Item = { kind: 'g'; id: string; main: string; secondary: string } | { kind: 'o'; place: FoundPlace };

export function addressSearch(
  input: HTMLInputElement,
  results: HTMLElement,
  opts: { near: () => LatLon | null | undefined; onPick: (p: FoundPlace) => void; onBusy?: (b: boolean) => void },
): AddressSearch {
  let session = newSession();
  let timer: number | undefined;
  let seq = 0;
  let google: boolean | null = null; // null = ainda não sabemos
  let list: Item[] = [];

  function render(note = '') {
    results.hidden = !list.length && !note;
    results.innerHTML =
      list
        .map((x, i) =>
          '<button type="button" class="row simple" data-i="' + i + '"><span class="mid"><span class="a">' + esc(x.kind === 'g' ? x.main : x.place.label) + '</span><span class="b">' + esc(x.kind === 'g' ? x.secondary : x.place.detail) + '</span></span><span></span><span class="chev">' + ICON.chev + '</span></button>',
        )
        .join('') + (note ? '<div class="list-note">' + esc(note) + '</div>' : '');
  }

  const empty = 'Nada encontrado. Tente com o bairro e a cidade.';

  /** Busca completa no Nominatim (só ao confirmar, como pede o serviço). */
  async function nominatim() {
    const q = input.value.trim();
    if (q.length < 3) return;
    const my = ++seq;
    opts.onBusy?.(true);
    try {
      const found = await searchAddress(q, opts.near());
      if (my !== seq) return;
      list = found.map((place) => ({ kind: 'o' as const, place }));
      render(found.length ? '' : empty);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      opts.onBusy?.(false);
    }
  }

  async function osmSuggest(q: string, my: number) {
    try {
      const found = await suggestOSM(q, opts.near());
      if (my !== seq) return;
      list = found.map((place) => ({ kind: 'o' as const, place }));
      render(found.length ? '' : empty);
    } catch {
      if (my !== seq) return;
      list = [];
      render('Sugestões indisponíveis agora. Toque em Ir para buscar.');
    }
  }

  async function suggest() {
    const q = input.value.trim();
    if (q.length < 3) {
      ++seq;
      list = [];
      return render();
    }
    const my = ++seq;
    if (google !== false) {
      const s = await suggestAddress(q, session, opts.near());
      if (my !== seq) return;
      if (s !== null) {
        google = true;
        list = s.map((x) => ({ kind: 'g' as const, ...x }));
        return render(s.length ? '' : empty);
      }
      google = false;
    }
    await osmSuggest(q, my);
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = window.setTimeout(suggest, google === false ? 300 : 250);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    clearTimeout(timer);
    // Enter com sugestões na tela escolhe a primeira; sem sugestões, faz a busca completa
    const first = results.querySelector<HTMLElement>('[data-i="0"]');
    if (first && !results.hidden) first.click();
    else if (google) suggest();
    else nominatim();
  });
  results.addEventListener('click', async (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-i]');
    if (!b) return;
    const x = list[Number(b.dataset.i)];
    if (!x) return;
    try {
      opts.onBusy?.(true);
      const place: FoundPlace = x.kind === 'g' ? await placeDetails(x.id, session) : x.place;
      session = newSession();
      ++seq;
      list = [];
      input.value = '';
      render();
      opts.onPick(place);
    } catch (err) {
      toast((err as Error).message);
    } finally {
      opts.onBusy?.(false);
    }
  });

  return {
    focus: () => input.focus({ preventScroll: true }),
    clear: () => {
      ++seq;
      input.value = '';
      list = [];
      render();
    },
  };
}
