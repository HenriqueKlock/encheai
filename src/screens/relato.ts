// Relatar problema ou sugestão (Perfil). Vai para a função `relato`, que guarda e manda e-mail ao dono do app.
import { currentSession, supabase } from '../sync';
import { $, closeSheets, openSheet, toast } from '../ui';
import { currentRoute } from '../router';

declare const __BUILD__: string;

export function initRelato() {
  let tipo: 'problema' | 'sugestao' = 'problema';
  let from = 'perfil';
  let shots: { url: string; data: string }[] = [];

  /** Reduz o print para no máximo 1600 px e JPEG: legível e leve para enviar pelo celular. */
  async function shrink(file: File): Promise<{ url: string; data: string }> {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const cv = document.createElement('canvas');
    cv.width = Math.round(bmp.width * k);
    cv.height = Math.round(bmp.height * k);
    const ctx = cv.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.drawImage(bmp, 0, 0, cv.width, cv.height);
    bmp.close?.();
    let url = cv.toDataURL('image/jpeg', 0.82);
    if (url.length > 3_500_000) url = cv.toDataURL('image/jpeg', 0.6);
    return { url, data: url.slice(url.indexOf(',') + 1) };
  }
  function renderShots() {
    $('relato-shots').innerHTML = shots.map((s, i) => '<span class="shot"><img src="' + s.url + '" alt="Print ' + (i + 1) + '"><button type="button" data-rm-shot="' + i + '" aria-label="Tirar print ' + (i + 1) + '">×</button></span>').join('');
    $('relato-add').hidden = shots.length >= 3;
  }

  document.body.insertAdjacentHTML(
    'beforeend',
    `<form class="sheet" id="relato-sheet" novalidate aria-labelledby="relato-title">
      <div class="grab"></div>
      <div class="sheet-body"><div class="stack">
        <h2 id="relato-title" class="sheet-title">Relatar problema ou sugestão</h2>
        <div class="seg" role="tablist" id="relato-tipo"><button type="button" role="tab" data-t="problema" aria-selected="true">Problema</button><button type="button" role="tab" data-t="sugestao" aria-selected="false">Sugestão</button></div>
        <label class="field"><span id="relato-label">O que aconteceu?</span><textarea class="inp" id="relato-msg" rows="5" maxlength="4000"></textarea></label>
        <div class="field"><span>Prints (opcional, até 3)</span>
          <div class="shots" id="relato-shots"></div>
          <button type="button" class="btn sm" id="relato-add">Anexar print</button>
          <input type="file" id="relato-file" accept="image/*" multiple hidden>
        </div>
        <label class="field" id="relato-contato-box" hidden>Seu e-mail, se quiser resposta<input class="inp sm" id="relato-contato" type="email" inputmode="email" autocomplete="email" maxlength="120"></label>
        <label class="check-row"><input type="checkbox" id="relato-info" checked><span>Enviar junto a versão do app e o tipo de aparelho (ajuda a achar o problema)</span></label>
        <input type="text" id="relato-site" name="site" tabindex="-1" autocomplete="off" class="hp" aria-hidden="true">
        <div class="err" id="relato-err" hidden></div>
        <div class="btn-row"><button type="button" class="btn" data-close>Cancelar</button><button type="submit" class="btn primary" id="relato-go">Enviar</button></div>
      </div></div>
    </form>`,
  );

  function setTipo(t: typeof tipo) {
    tipo = t;
    document.querySelectorAll<HTMLElement>('#relato-tipo [data-t]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.t === t)));
    $('relato-label').textContent = t === 'problema' ? 'O que aconteceu? Conte o que você fez e o que esperava.' : 'Qual é a sua ideia?';
    $<HTMLTextAreaElement>('relato-msg').placeholder = t === 'problema' ? 'Ex.: no Perfil, toquei em Sincronizar e apareceu um erro…' : 'Ex.: seria bom ver o gasto por viagem…';
  }

  async function open() {
    from = currentRoute().view + (currentRoute().sub ? '/' + currentRoute().sub : '');
    $('relato-err').hidden = true;
    $<HTMLTextAreaElement>('relato-msg').value = '';
    shots = [];
    renderShots();
    setTipo('problema');
    $('relato-contato-box').hidden = !!(await currentSession());
    openSheet('relato-sheet');
    setTimeout(() => $('relato-msg').focus(), 250);
  }

  $('relato-add').addEventListener('click', () => $<HTMLInputElement>('relato-file').click());
  $('relato-file').addEventListener('change', async () => {
    const input = $<HTMLInputElement>('relato-file');
    const files = Array.from(input.files ?? []).filter((f) => f.type.startsWith('image/'));
    input.value = '';
    for (const f of files.slice(0, 3 - shots.length)) {
      try {
        shots.push(await shrink(f));
      } catch {
        toast('Não consegui abrir essa imagem. Tente um print em PNG ou JPG.');
      }
    }
    if (files.length > 3) toast('Até 3 prints por relato.');
    renderShots();
  });
  $('relato-shots').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-rm-shot]');
    if (!b) return;
    shots.splice(Number(b.dataset.rmShot), 1);
    renderShots();
  });

  $('relato-tipo').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-t]');
    if (b) setTipo(b.dataset.t as typeof tipo);
  });

  $('relato-sheet').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $<HTMLTextAreaElement>('relato-msg').value.trim();
    const err = (m: string) => { $('relato-err').textContent = m; $('relato-err').hidden = false; };
    if (msg.length < 3) return err('Escreva o que aconteceu ou a sua ideia.');
    if (navigator.onLine === false) return err('Sem internet agora. Tente de novo quando conectar.');
    const info = $<HTMLInputElement>('relato-info').checked;
    const btn = $<HTMLButtonElement>('relato-go');
    btn.disabled = true;
    try {
      const { data, error } = await supabase.functions.invoke('relato', {
        body: {
          tipo, mensagem: msg, contato: $<HTMLInputElement>('relato-contato').value.trim() || undefined,
          tela: from, versao: info ? __BUILD__ : undefined,
          aparelho: info ? (navigator.userAgent + ' · ' + screen.width + '×' + screen.height).slice(0, 300) : undefined,
          site: $<HTMLInputElement>('relato-site').value || undefined,
          prints: shots.length ? shots.map((s) => ({ dados: s.data })) : undefined,
        },
      });
      if (error) {
        let m = 'Não deu para enviar agora. Tente de novo em instantes.';
        try { m = (await (error as any).context?.json())?.error ?? m; } catch { /* sem corpo */ }
        return err(m);
      }
      void data;
      closeSheets();
      toast(tipo === 'problema' ? 'Recebido. Obrigado por avisar!' : 'Recebido. Obrigado pela ideia!');
    } finally {
      btn.disabled = false;
    }
  });

  document.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('[data-act="relato"]')) open();
  });
  return { open };
}
