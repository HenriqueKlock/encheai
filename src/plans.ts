/**
 * Planos de manutenção do fabricante, embutidos no app (funcionam offline).
 * Itens marcados como `preliminary` ainda não foram conferidos no manual do proprietário.
 */
export type PlanAction = 'trocar' | 'inspecionar';

export interface PlanItem {
  key: string;
  description: string;
  action: PlanAction;
  interval_km: number | null;
  interval_months: number | null;
  /** Intervalo em uso severo, só informativo. */
  severe_km?: number | null;
  note?: string;
  preliminary: boolean;
}

export interface Plan {
  key: string;
  name: string;
  summary: string;
  sources: { label: string; url: string }[];
  items: PlanItem[];
  /** Só aparece como opção para carros cujo "marca modelo" combina com isto. Sem `match`, serve para todos. */
  match?: RegExp;
}

/** Plano que a pessoa adotou e ajustou, guardado no próprio carro (vehicles.plan_custom). */
export interface CustomPlan {
  /** Modelo de onde partiu (para mostrar as fontes), ou null se montado do zero. */
  base: string | null;
  items: PlanItem[];
}

/** Ponto de partida que serve para qualquer carro de passeio. */
export const BASIC_PLAN: Plan = {
  key: 'basico',
  name: 'Plano básico',
  summary: 'Intervalos comuns para carros de passeio. Confira no manual do seu carro e ajuste o que for diferente.',
  sources: [],
  items: [
    { key: 'oleo_motor', description: 'Óleo do motor', action: 'trocar', interval_km: 10000, interval_months: 12, preliminary: false },
    { key: 'filtro_oleo', description: 'Filtro de óleo', action: 'trocar', interval_km: 10000, interval_months: 12, preliminary: false },
    { key: 'filtro_ar', description: 'Filtro de ar do motor', action: 'trocar', interval_km: 20000, interval_months: 24, preliminary: false },
    { key: 'filtro_cabine', description: 'Filtro de cabine (ar-condicionado)', action: 'trocar', interval_km: 15000, interval_months: 12, preliminary: false },
    { key: 'filtro_combustivel', description: 'Filtro de combustível', action: 'trocar', interval_km: 30000, interval_months: 24, preliminary: false },
    { key: 'velas', description: 'Velas de ignição', action: 'trocar', interval_km: 40000, interval_months: null, note: 'Velas de irídio duram mais; veja o manual', preliminary: false },
    { key: 'fluido_freio', description: 'Fluido de freio', action: 'trocar', interval_km: null, interval_months: 24, preliminary: false },
    { key: 'arrefecimento', description: 'Líquido de arrefecimento', action: 'trocar', interval_km: 50000, interval_months: 36, preliminary: false },
    { key: 'correia_acessorios', description: 'Correia de acessórios', action: 'inspecionar', interval_km: 30000, interval_months: null, preliminary: false },
  ],
};

export const PLANS: Plan[] = [
  {
    key: 'hyundai-creta-2.0-at-2017-2021',
    name: 'Hyundai Creta 2.0 AT (2017–2021)',
    match: /creta/i,
    summary:
      'Revisões a cada 10.000 km ou 12 meses. Detalhe por item vem do Creta 1.6 AT; conferir no manual do 2.0 os itens marcados.',
    sources: [
      { label: 'Motor Show: revisões do Creta até 100 mil km', url: 'https://motorshow.com.br/veja-quanto-custa-manter-um-hyundai-creta-1-6-ate-os-100-000-km/' },
      { label: 'O Mecânico: Raio X do Creta 1.6 AT', url: 'https://omecanico.com.br/raio-x-hyundai-creta-1-6-at/' },
    ],
    items: [
      { key: 'oleo_motor', description: 'Óleo do motor', action: 'trocar', interval_km: 10000, interval_months: 12, severe_km: 5000, preliminary: false },
      { key: 'filtro_oleo', description: 'Filtro de óleo', action: 'trocar', interval_km: 10000, interval_months: 12, severe_km: 5000, preliminary: false },
      { key: 'filtro_cabine', description: 'Filtro de cabine (ar-condicionado)', action: 'trocar', interval_km: 20000, interval_months: 24, preliminary: true },
      { key: 'filtro_ar', description: 'Filtro de ar do motor', action: 'trocar', interval_km: 40000, interval_months: 48, note: 'Antes, se estiver sujo', preliminary: true },
      { key: 'filtro_combustivel', description: 'Filtro de combustível', action: 'trocar', interval_km: null, interval_months: null, note: 'Intervalo não consta nas fontes; conferir no manual', preliminary: true },
      { key: 'correia_acessorios', description: 'Correia de acessórios', action: 'inspecionar', interval_km: 30000, interval_months: null, note: 'Sem troca programada', preliminary: true },
      { key: 'velas', description: 'Velas de ignição', action: 'trocar', interval_km: 160000, interval_months: null, note: 'Intervalo do 1.6; mecânico recomenda inspecionar a cada 30.000 km', preliminary: true },
      { key: 'arrefecimento', description: 'Líquido de arrefecimento', action: 'trocar', interval_km: 100000, interval_months: null, preliminary: true },
      { key: 'fluido_freio', description: 'Fluido de freio', action: 'trocar', interval_km: null, interval_months: 24, note: 'Recomendação de mecânico; o manual do 1.6 não fixa intervalo', preliminary: true },
      { key: 'folga_valvulas', description: 'Folga de válvulas', action: 'inspecionar', interval_km: 90000, interval_months: 72, preliminary: true },
      { key: 'fluido_cambio', description: 'Fluido do câmbio automático', action: 'trocar', interval_km: null, interval_months: null, severe_km: 100000, note: 'Sem troca em uso normal; 100.000 km em uso severo', preliminary: true },
    ],
  },
];

/** Chaves antigas (app anterior) que apontam para o mesmo plano. */
const ALIASES: Record<string, string> = { 'hyundai-creta-2.0': 'hyundai-creta-2.0-at-2017-2021' };
export const planByKey = (key: string | null | undefined) =>
  key === BASIC_PLAN.key ? BASIC_PLAN : PLANS.find((p) => p.key === key || (key && ALIASES[key] === p.key));

/** Modelos que fazem sentido para este carro: o básico e os do fabricante que combinam com a marca e o modelo. */
export function templatesFor(v: { make?: string | null; model?: string | null; name?: string | null }): Plan[] {
  const id = [v.make, v.model, v.name].filter(Boolean).join(' ');
  return [BASIC_PLAN, ...PLANS.filter((p) => !p.match || p.match.test(id))];
}

/** O plano que vale para o carro: o próprio (ajustado) ou, em carros antigos no app, o modelo escolhido. */
export function planOf(v: { name: string; plan_key: string | null; plan_custom?: CustomPlan | null }): Plan | undefined {
  const c = v.plan_custom;
  if (c && Array.isArray(c.items)) {
    const base = planByKey(c.base);
    return {
      key: 'custom',
      name: 'Plano do ' + v.name,
      summary: base ? 'Partiu de: ' + base.name + '.' : 'Montado por você.',
      sources: base?.sources ?? [],
      items: c.items,
    };
  }
  return planByKey(v.plan_key);
}

/** Chave para um item criado pela pessoa (fora da lista de categorias). */
export const customKey = (description: string) =>
  'meu_' + description.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
