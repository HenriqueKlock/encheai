// Boas-vindas: o que o app faz, a escolha de contribuir com a rede (LGPD) e a entrada por e-mail.
// Aparece até a pessoa entrar ou escolher usar sem conta.
import { getMeta, setMeta } from '../db';
import { TERMS_VERSION } from '../config';
import { getHomePrefs, setContribute } from '../sync';
import { $ } from '../ui';
import { renderLogin } from './conta';
import { DROP, isNovo } from '../visual';

const DONE = 'welcome_done';
/** Quem passou pelas boas-vindas já viu a política atual: não precisa do aviso de atualização no Início. */
const markPolicySeen = () => { try { localStorage.setItem('politica_vista', '2026-10-22'); } catch { /* sem acesso */ } };
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

export function showWelcome(opts: { onClose: () => void }) {
  const el = $('v-boasvindas');
  document.body.classList.add('welcoming');
  el.hidden = false;
  el.innerHTML = isNovo() ? NOVO :
    '<div class="welcome-in">' +
    '<div class="brand"><span class="logo only-v1"><svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v15M3 20h12M14 9h2a2 2 0 0 1 2 2v5a1.5 1.5 0 0 0 3 0V8l-3-3M7 7h4"/></svg></span><span class="only-v1">Enche AI</span><span class="logo2 only-v2">' + DROP(36, '#C3F25C') + '</span><span class="wordmark only-v2">Enche <em>AI</em></span></div>' +
    '<h1 class="only-v1">Saiba em qual posto vale abastecer, medido por quem abastece lá.</h1>' +
    '<h1 class="only-v2">Abasteça com inteligência.</h1><p class="w-sub only-v2">Onde vale abastecer, medido por quem abastece lá.</p>' +
    '<ul class="values">' +
    '<li><span class="vi">' + BOOK + '</span><span><b>Seu caderno do carro</b><span>Consumo, gastos e manutenção. Funciona sem internet.</span></span></li>' +
    '<li><span class="vi blue">' + PIN + '</span><span><b>Postos com dados de verdade</b><span>Preço recente, fiscalização da ANP e quanto o combustível rende para quem abastece lá.</span></span></li>' +
    '<li><span class="vi green">' + CHECK + '</span><span><b>Avalie em um toque</b><span>Nota do posto e, no dia seguinte, como o carro andou com aquele combustível.</span></span></li>' +
    '<li><span class="vi">' + UPLOAD + '</span><span><b>Traga seu histórico</b><span>Planilha, PDF de manutenção com a sua IA ou o Claude. Nada entra antes de você conferir.</span></span></li>' +
    '</ul>' +
    '<div class="consent"><label><input type="checkbox" id="w-consent" checked>Contribuir com a rede, sem meu nome</label>' +
    '<span>Seus abastecimentos com posto entram só em médias por posto, com volume mínimo: nunca quem, nunca o horário, nunca casa ou trabalho. Esses números agregados também podem ir para relatórios e parcerias. Desmarque aqui ou desligue depois no Perfil. Para maiores de 18 anos.</span>' +
    '<a href="#/privacidade" id="w-privacy">Ler a política de privacidade</a></div>' +
    '<div id="w-login"></div>' +
    '<button type="button" class="text-btn" id="w-skip">Usar sem conta por enquanto</button>' +
    '<p class="skip-note">Sem conta, o caderno do carro funciona neste celular, mas você não vê o preço que a rede pagou nem o rendimento medido de cada posto, e seus dados não ficam guardados na nuvem.</p>' +
    '</div>';
  const consent = $<HTMLInputElement>('w-consent');
  const remember = () => setMeta(CHOICE, consent.checked);
  remember();
  markPolicySeen();
  consent.addEventListener('change', remember);
  renderLogin($('w-login'), isNovo() ? { compact: true, bare: true, cta: 'Entrar com link no e-mail' } : { compact: true });
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

const PUMP = '<svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v15M3 20h12M14 9h2a2 2 0 0 1 2 2v5a1.5 1.5 0 0 0 3 0V8l-3-3"/></svg>';
const SHIELD = '<svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v5.5c0 4.3-3 8-7 9.5-4-1.5-7-5.2-7-9.5V6z"/><path d="M8.8 12.2l2.2 2.2 4.4-4.6"/></svg>';
const GAUGE = '<svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 16a8 8 0 1 1 16 0"/><path d="M12 16l4-5"/></svg>';

/** Boas-vindas do visual novo: três promessas curtas, o interruptor da rede e o e-mail. */
const NOVO =
  '<div class="welcome-in w2">' +
  '<span class="w2-drop" aria-hidden="true">' + DROP(420, '#C3F25C') + '</span>' +
  '<div class="brand"><span class="logo2">' + DROP(36, '#C3F25C') + '</span><span class="wordmark">Enche <em>AI</em></span></div>' +
  '<div class="w2-head"><h1>Abasteça com inteligência.</h1><p class="w-sub">Onde vale abastecer, medido por quem abastece lá.</p></div>' +
  '<ul class="values">' +
  '<li><span class="vi">' + PUMP + '</span><span><b>Preço de hoje</b><span>de quem abasteceu e da ANP</span></span></li>' +
  '<li><span class="vi">' + SHIELD + '</span><span><b>Posto confiável</b><span>fiscalização e avaliações</span></span></li>' +
  '<li><span class="vi">' + GAUGE + '</span><span><b>Quanto rende de verdade</b><span>o consumo medido do seu carro</span></span></li>' +
  '</ul>' +
  '<div class="w2-foot">' +
  '<label class="w2-switch"><span>Contribuir com a rede, sem meu nome</span><input type="checkbox" class="switch" role="switch" id="w-consent" checked></label>' +
  '<p class="w2-legal">Só médias por posto, nunca quem nem quando. Para maiores de 18. <a href="#/privacidade" id="w-privacy">Política de privacidade</a></p>' +
  '<div id="w-login"></div>' +
  '<button type="button" class="text-btn" id="w-skip">Usar sem conta</button>' +
  '</div></div>';

const BOOK ='<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4h11a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2z"/><path d="M5 18a2 2 0 0 1 2-2h11M9 8h5M9 11h5"/></svg>';
const PIN = '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>';
const UPLOAD = '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V4M7.5 8.5 12 4l4.5 4.5"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/></svg>';
const CHECK = '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l4 4 10-10"/></svg>';
