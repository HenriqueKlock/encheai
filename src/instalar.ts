// Instalação como app (Chrome/Android): guarda o convite do navegador para oferecer no Perfil.
interface InstallPrompt extends Event { prompt(): Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> }

let deferred: InstallPrompt | null = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

export function startInstall() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as InstallPrompt;
    emit();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    emit();
  });
}
export const onInstallChange = (f: () => void) => subs.add(f);
export const canInstall = () => !!deferred;
export const isStandalone = () => matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone === true;

export async function install(): Promise<boolean> {
  if (!deferred) return false;
  const d = deferred;
  deferred = null;
  await d.prompt();
  const { outcome } = await d.userChoice;
  emit();
  return outcome === 'accepted';
}
