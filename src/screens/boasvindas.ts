// Boas-vindas: o que o app faz, a escolha de contribuir com a rede (LGPD) e a entrada por e-mail.
// Aparece até a pessoa entrar ou escolher usar sem conta.
import { getMeta, setMeta } from '../db';
import { TERMS_VERSION } from '../config';
import { getHomePrefs, setContribute } from '../sync';
import { $ } from '../ui';
import { renderLogin } from './conta';

const DONE = 'welcome_done';
const CHOICE = 'consent_choice';

export async function shouldWelcome(signedIn: boolean) {
  return !signedIn && !(await getMeta<boolean>(DONE, false));
}

/** Depois de entrar: aplica a escolha feita nas boas-vindas (se a conta ainda não tem uma). */
export async function applyConsentChoice() {
  const choice = await getMeta<boolean | null>(CHOICE, null);
  const prefs = await getHomePrefs();
  if (choice !== null && !prefs.consent_at && !prefs.terms_version) await setContribute(choice, TERMS_VERSION);
  await setMeta(DONE, true);
}

export function showWelcome(opts: { legacyCount: number | null; onClose: () => void }) {
  const el = $('v-boasvindas');
  document.body.classList.add('welcoming');
  el.hidden = false;
  el.innerHTML =
    '<div class="welcome-in">' +
    '<div class="brand"><span class="logo"><svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v15M3 20h12M14 9h2a2 2 0 0 1 2 2v5a1.5 1.5 0 0 0 3 0V8l-3-3M7 7h4"/></svg></span><span>Caderneta do Carro</span></div>' +
    '<h1>Saiba em qual posto vale abastecer, medido por quem abastece lá.</h1>' +
    '<ul class="values">' +
    '<li><span class="vi">' + BOOK + '</span><span><b>Seu caderno do carro</b><span>Consumo, gastos e manutenção. Funciona sem internet.</span></span></li>' +
    '<li><span class="vi blue">' + PIN + '</span><span><b>Postos com dados de verdade</b><span>Preço recente, fiscalização da ANP e quanto o combustível rende para quem abastece lá.</span></span></li>' +
    '<li><span class="vi green">' + CHECK + '</span><span><b>Avalie em um toque</b><span>Depois de abastecer: bomba, atendimento e banheiro.</span></span></li>' +
    '</ul>' +
    (opts.legacyCount ? '<p class="legacy-note">Encontramos ' + opts.legacyCount + ' abastecimentos do app anterior neste celular. Depois de entrar, toque em “Trazer meus dados” no Início.</p>' : '') +
    '<div class="consent"><label><input type="checkbox" id="w-consent" checked>Contribuir com a rede, sem meu nome</label>' +
    '<span>Publicamos só médias por posto, com volume mínimo. Nunca quem, nunca o horário, nunca casa ou trabalho. Dá para desligar no Perfil.</span>' +
    '<a href="#/privacidade" id="w-privacy">Ler a política de privacidade</a></div>' +
    '<div id="w-login"></div>' +
    '<button type="button" class="text-btn" id="w-skip">Usar sem conta por enquanto</button>' +
    '</div>';
  const consent = $<HTMLInputElement>('w-consent');
  const remember = () => setMeta(CHOICE, consent.checked);
  remember();
  consent.addEventListener('change', remember);
  renderLogin($('w-login'), { compact: true });
  $('w-privacy').addEventListener('click', () => close(false));
  $('w-skip').addEventListener('click', async () => {
    await setMeta(DONE, true);
    close(true);
  });
  function close(done: boolean) {
    el.hidden = true;
    document.body.classList.remove('welcoming');
    if (done) opts.onClose();
  }
}

export function hideWelcome() {
  $('v-boasvindas').hidden = true;
  document.body.classList.remove('welcoming');
}

const BOOK = '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4h11a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2z"/><path d="M5 18a2 2 0 0 1 2-2h11M9 8h5M9 11h5"/></svg>';
const PIN = '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>';
const CHECK = '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l4 4 10-10"/></svg>';
