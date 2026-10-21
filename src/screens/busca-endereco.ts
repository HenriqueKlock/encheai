// Campo de endereço com sugestões enquanto digita (Google) e, sem o Google, busca no OpenStreetMap ao confirmar.
// Cada campo tem o próprio estado: o texto de um nunca aparece no outro.
import { newSession, placeDetails, searchAddress, suggestAddress, type FoundPlace } from '../lugares';
import type { LatLon } from '../postos';
import { esc, toast } from '../ui';
import { ICON } from '../icons';

export interface AddressSearch { focus(): void; clear(): void }

export function addressSearch(
  input: HTMLInputElement,
  results: HTMLElement,
  opts: { near: () => LatLon | null | undefined; onPick: (p: FoundPlace) => void; onBusy?: (b: boolean) => void },
): AddressSearch {
  let session = newSession();
  let timer: number | undefined;
  let seq = 0;
  let google: boolean | null = null; // null = ainda não sabemos
  let list: { kind: 'g'; id: string; main: string; secondary: string }[] | { kind: 'o'; place: FoundPlace }[] = [];

  function render(note = '') {
    results.hidden = !list.length && !note;
    results.innerHTML =
      (list as any[])
        .map((x, i) =>
          '<button type="button" class="row simple" data-i="' + i + '"><span class="mid"><span class="a">' + esc(x.kind === 'g' ? x.main : x.place.label) + '</span><span class="b">' + esc(x.kind === 'g' ? x.secondary : x.place.detail) + '</span></span><span></span><span class="chev">' + ICON.chev + '</span></button>',
        )
        .join('') + (note ? '<div class="list-note">' + esc(note) + '</div>' : '');
  }

  async function osm() {
    const q = input.value.trim();
    if (q.length < 3) return;
    const my = ++seq;
    opts.onBusy?.(true);
    try {
      const found = await searchAddress(q, opts.near());
      if (my !== seq) return;
      list = found.map((place) => ({ kind: 'o' as const, place }));
      render(found.length ? 'Resultados do OpenStreetMap' : 'Nada encontrado. Tente com bairro e cidade.');
    } catch (e) {
      toast((e as Error).message);
    } finally {
      opts.onBusy?.(false);
    }
  }

  async function suggest() {
    const q = input.value.trim();
    if (q.length < 3) {
      list = [];
      return render();
    }
    if (google === false) return render('Toque em Enter (ou Ir) para buscar.');
    const my = ++seq;
    const s = await suggestAddress(q, session, opts.near());
    if (my !== seq) return;
    if (s === null) {
      google = false;
      list = [];
      return render('Toque em Enter (ou Ir) para buscar.');
    }
    google = true;
    list = s.map((x) => ({ kind: 'g' as const, ...x }));
    render(s.length ? '' : 'Nenhuma sugestão. Tente com bairro e cidade.');
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = window.setTimeout(suggest, 350);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    clearTimeout(timer);
    if (google) suggest();
    else osm();
  });
  results.addEventListener('click', async (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-i]');
    if (!b) return;
    const x = (list as any[])[Number(b.dataset.i)];
    if (!x) return;
    try {
      opts.onBusy?.(true);
      const place: FoundPlace = x.kind === 'g' ? await placeDetails(x.id, session) : x.place;
      session = newSession();
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
      input.value = '';
      list = [];
      render();
    },
  };
}
