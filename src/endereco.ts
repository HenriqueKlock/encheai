// Nome do lugar sugerido pelo OpenStreetMap (Photon), sem número da casa. Puro, testado em tests/lugares.test.ts.

export function photonLabel(p: Record<string, any>): { label: string; detail: string } {
  const type = String(p.type ?? '');
  const isStreet = type === 'street' || p.osm_key === 'highway';
  const isArea = ['district', 'locality', 'city', 'county', 'state'].includes(type);
  const hood = p.district || p.locality || '';
  const city = p.city || p.county || '';
  // Sem número da casa: rua e bairro, ou o nome do lugar
  let label: string;
  if (isStreet) label = [p.name, hood].filter(Boolean).join(' · ');
  else if (type === 'house' && !p.name) label = [p.street, hood].filter(Boolean).join(' · ');
  else if (isArea) label = p.name ?? '';
  else label = [p.name, p.street].filter(Boolean).join(' · ');
  const detail = [isStreet || isArea || (type === 'house' && !p.name) ? '' : hood, city !== label ? city : '', p.state].filter(Boolean).join(', ');
  return { label: String(label).slice(0, 100), detail };
}
