// "Informar preço": quem passa no posto conta o preço da bomba sem precisar abastecer.
// Vai para price_reports (só a própria conta vê a linha; a rede publica só o preço por posto, como
// "informado", e o preço de quem abasteceu vale antes). Uma cópia fica no aparelho por 7 dias para
// a própria pessoa já ver o preço que informou.
import { supabase } from './sync';
import type { Fuel, OwnPrice } from './postos';

const KEY = 'precos_informados';
const DAYS = 7;

export interface Reported { station_id: string; fuel: Fuel; price: number; date: string }

const todayBR = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);

export function reportedPrices(): Reported[] {
  try {
    const all = JSON.parse(localStorage.getItem(KEY) ?? '[]') as Reported[];
    const min = new Date(Date.parse(todayBR()) - DAYS * 864e5).toISOString().slice(0, 10);
    return all.filter((r) => r.date >= min);
  } catch {
    return [];
  }
}

export function reportedAsOwn(): OwnPrice[] {
  return reportedPrices().map((r) => ({ station_id: r.station_id, fuel: r.fuel, price: r.price, date: r.date, seen: true }));
}

/** Faixa aceita (a mesma do servidor). */
export function plausible(fuel: Fuel, price: number): boolean {
  return fuel === 'etanol' ? price >= 2 && price <= 9 : price >= 3 && price <= 12;
}

/** Envia os preços vistos; devolve uma mensagem de erro ou null. */
export async function reportPrices(stationId: string, items: { fuel: Fuel; price: number }[]): Promise<string | null> {
  if (!items.length) return 'Digite pelo menos um preço.';
  for (const i of items) if (!plausible(i.fuel, i.price)) return 'O preço de ' + i.fuel + ' parece errado. Confira o valor por litro.';
  const { error } = await supabase
    .from('price_reports')
    .upsert(items.map((i) => ({ station_id: stationId, fuel: i.fuel, price: Math.round(i.price * 1000) / 1000 })), { onConflict: 'user_id,station_id,fuel,day' });
  if (error) {
    if (/limite/.test(error.message)) return 'Você já informou muitos preços hoje. Amanhã tem mais.';
    if (/faixa/.test(error.message)) return 'Um dos preços está fora da faixa esperada. Confira o valor por litro.';
    return 'Não deu para enviar agora. Confira a internet e tente de novo.';
  }
  const date = todayBR();
  const keep = reportedPrices().filter((r) => !(r.station_id === stationId && r.date === date && items.some((i) => i.fuel === r.fuel)));
  try {
    localStorage.setItem(KEY, JSON.stringify([...keep, ...items.map((i) => ({ station_id: stationId, fuel: i.fuel, price: i.price, date }))]));
  } catch { /* sem acesso */ }
  return null;
}
