// Entrar sem senha: link (ou código) enviado por e-mail. Usado nas boas-vindas e no Perfil.
import { sendLoginEmail, sync, verifyCode } from '../sync';
import { esc, toast } from '../ui';

let otpEmail = '';
let otpSent = false;

export function resetLogin() {
  otpSent = false;
}

/** Desenha o formulário de entrada dentro de `box` e liga os botões. `onDone` roda ao entrar pelo código. */
export function renderLogin(box: HTMLElement, opts: { cta?: string; onDone?: () => void; compact?: boolean } = {}) {
  box.innerHTML = otpSent
    ? '<div class="login sent"><div class="t">Confira seu e-mail</div><div class="d">Enviamos um link de acesso para <b>' + esc(otpEmail) + '</b>. Abra o e-mail <b>neste aparelho</b> e toque no link: o app abre já conectado. Pode levar um minuto e às vezes cai no spam.</div>' +
      '<label class="field">Se o e-mail trouxe um código, digite aqui<input class="inp sm" data-l="code" inputmode="numeric" autocomplete="one-time-code" maxlength="8"></label>' +
      '<div class="err" data-l="err" hidden></div>' +
      '<div class="btn-row"><button type="button" class="btn" data-l="back">Trocar e-mail</button><button type="button" class="btn primary" data-l="go">Entrar com código</button></div></div>'
    : '<div class="login">' + (opts.compact ? '' : '<div class="t">Entrar</div><div class="d">Sem senha: você recebe um link de acesso no e-mail. Seus dados ficam na sua conta e aparecem em qualquer aparelho.</div>') +
      '<label class="field">Seu e-mail<input class="inp sm" data-l="email" type="email" inputmode="email" autocomplete="email" placeholder="voce@email.com" value="' + esc(otpEmail) + '"></label>' +
      '<div class="err" data-l="err" hidden></div>' +
      '<button type="button" class="btn primary block" data-l="go">' + esc(opts.cta ?? 'Receber link de acesso') + '</button></div>';

  const q = <T extends HTMLElement>(k: string) => box.querySelector<T>('[data-l="' + k + '"]');
  const err = (m: string) => {
    const el = q('err');
    if (el) { el.textContent = m; el.hidden = false; }
  };
  q('back')?.addEventListener('click', () => {
    otpSent = false;
    renderLogin(box, opts);
  });
  q<HTMLInputElement>('email')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') q<HTMLButtonElement>('go')?.click();
  });
  q<HTMLButtonElement>('go')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    if (navigator.onLine === false) return err('Sem internet. Conecte-se para entrar.');
    btn.disabled = true;
    try {
      if (!otpSent) {
        otpEmail = q<HTMLInputElement>('email')!.value.trim().toLowerCase();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(otpEmail)) throw new Error('Digite um e-mail válido.');
        await sendLoginEmail(otpEmail);
        otpSent = true;
        toast('Link enviado para ' + otpEmail);
      } else {
        const code = q<HTMLInputElement>('code')!.value.replace(/\D/g, '');
        if (code.length < 6 || code.length > 8) throw new Error('Digite o código numérico que chegou no e-mail.');
        await verifyCode(otpEmail, code);
        otpSent = false;
        toast('Conta conectada. Sincronizando…');
        opts.onDone?.();
        await sync();
      }
      renderLogin(box, opts);
    } catch (ex) {
      err((ex as Error).message);
    } finally {
      btn.disabled = false;
    }
  });
}
