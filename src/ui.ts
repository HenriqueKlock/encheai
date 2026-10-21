// Utilidades de tela: seletores, formatação em pt-BR, avisos (toast) e folhas.
import type { FuelType } from './db';

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
export const fmt = (n: number, d = 2) => (Number.isFinite(n) ? n.toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d }) : '–');
export const brl = (n: number) => 'R$ ' + fmt(n, 2);
export const km = (n: number) => (Number.isFinite(n) ? Math.round(n).toLocaleString('pt-BR') : '–');
export const MES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
export const dm = (iso: string) => iso.slice(8, 10) + '/' + iso.slice(5, 7);
export const monthYear = (iso: string) => MES[+iso.slice(5, 7) - 1] + '/' + iso.slice(2, 4);
export const pl = (n: number, one: string, many: string) => n + ' ' + (n === 1 ? one : many);
export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
export function todayISO() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}
/** "hoje", "ontem", "há 3 dias", "12/10" */
export function ago(iso: string, today = todayISO()) {
  const d = Math.round((Date.parse(today) - Date.parse(iso)) / 86400000);
  if (d <= 0) return 'hoje';
  if (d === 1) return 'ontem';
  if (d < 7) return 'há ' + d + ' dias';
  return dm(iso);
}
export const FUEL_LABEL: Record<FuelType, string> = { gasolina: 'Gasolina', etanol: 'Etanol', diesel: 'Diesel', gnv: 'GNV' };

/* ---------- aviso rápido ---------- */
let toastTimer: number | undefined;
export function toast(m: string) {
  const t = $('toast');
  t.classList.remove('sticky');
  t.textContent = m;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.classList.remove('show'), 2800);
}
export function stickyToast(m: string, label: string, action: () => void) {
  const t = $('toast');
  clearTimeout(toastTimer);
  t.innerHTML = '<span>' + esc(m) + '</span><button type="button">' + esc(label) + '</button>';
  t.classList.add('show', 'sticky');
  t.querySelector('button')!.addEventListener('click', action, { once: true });
}

/* ---------- folhas (com o botão voltar do celular fechando a folha) ---------- */
let openId: string | null = null;
const closeHooks = new Map<string, () => void>();
export function onSheetClose(id: string, fn: () => void) {
  closeHooks.set(id, fn);
}
/** Abre uma folha; se outra estiver aberta, troca no lugar (sem empilhar no histórico). */
export function openSheet(id: string) {
  if (openId && openId !== id) closeHooks.get(openId)?.();
  document.querySelectorAll('.sheet').forEach((s) => s.classList.toggle('open', s.id === id));
  $('scrim').classList.add('open');
  if (!openId) history.pushState({ sheet: id }, '');
  else history.replaceState({ sheet: id }, '');
  openId = id;
}
function hideSheets() {
  const was = openId;
  document.querySelectorAll('.sheet').forEach((s) => s.classList.remove('open'));
  $('scrim').classList.remove('open');
  openId = null;
  if (was) closeHooks.get(was)?.();
}
let after: (() => void) | null = null;
/** Fecha a folha aberta; `then` roda depois que o histórico voltou (para navegar em seguida sem conflito). */
export function closeSheets(then?: () => void) {
  if (!openId) {
    hideSheets();
    then?.();
    return;
  }
  after = then ?? null;
  // volta a entrada do histórico criada ao abrir; o popstate abaixo esconde a folha
  history.back();
}
export const sheetOpen = () => openId;
window.addEventListener('popstate', () => {
  if (openId) hideSheets();
  const fn = after;
  after = null;
  fn?.();
});
