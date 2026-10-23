// Primeiro carro: logo depois de entrar (ou de "usar sem conta"), quem não tem carro cadastra antes de seguir.
// Sem carro não dá para registrar abastecimento, calcular consumo nem contribuir com a rede.
// Postos continua livre: "Só quero ver preços agora" leva para lá, e o Início segue pedindo o carro.
import { db, setMeta, stamp, uuid, type Vehicle, type VehicleFuel } from '../db';
import { parseIntLoose } from '../calc';
import { go } from '../router';
import { $, esc, toast } from '../ui';
import { DROP } from '../visual';
import { track } from '../uso';

let shownThisOpen = false;

/** Há carro ativo neste aparelho? Lê a base direto (o store pode ainda não ter recarregado). */
export async function hasCar() {
  return (await db.vehicles.filter((v) => !v.archived && !v.deleted_at).count()) > 0;
}

/** Mostra a etapa uma vez por abertura do app, se não houver carro. */
export async function maybeCarStep() {
  if (shownThisOpen || (await hasCar())) return;
  shownThisOpen = true;
  showCarStep();
}

const FUELS: [VehicleFuel, string][] = [['flex', 'Flex'], ['gasolina', 'Gasolina'], ['etanol', 'Etanol'], ['diesel', 'Diesel']];

export function showCarStep() {
  const el = $('v-boasvindas');
  document.body.classList.add('welcoming');
  el.hidden = false;
  track('car_step');
  el.innerHTML =
    '<form class="welcome-in w2 car1" id="c1-form" novalidate>' +
    '<span class="w2-drop" aria-hidden="true">' + DROP(420, '#C3F25C') + '</span>' +
    '<div class="c1-dots" aria-hidden="true"><i class="on"></i><i class="on"></i><i></i></div>' +
    '<div class="w2-head"><span class="c1-step">Passo 2 de 3</span><h1>Qual é o seu carro?</h1>' +
    '<p class="w-sub">Com ele o app calcula o consumo e seus abastecimentos ajudam a medir o rendimento dos postos.</p></div>' +
    '<label class="c1-f">Modelo<input class="inp" id="c1-model" autocomplete="off" maxlength="60" placeholder="ex.: Creta 1.6 2020"></label>' +
    '<div class="c1-f">Combustível<div class="c1-seg" role="radiogroup">' +
    FUELS.map(([v, t], i) => '<label><input type="radio" name="c1-fuel" value="' + v + '"' + (i === 0 ? ' checked' : '') + '><span>' + esc(t) + '</span></label>').join('') +
    '</div></div>' +
    '<label class="c1-f">Km atual no painel<input class="inp" id="c1-km" inputmode="numeric" autocomplete="off" placeholder="ex.: 58.200"></label>' +
    '<div class="err" id="c1-err" hidden></div>' +
    '<div class="c1-foot"><button type="submit" class="btn primary block c1-go">Salvar e continuar</button>' +
    '<button type="button" class="text-btn" id="c1-skip">Só quero ver preços agora</button></div>' +
    '</form>';
  setTimeout(() => $<HTMLInputElement>('c1-model').focus({ preventScroll: true }), 300);
  $('c1-skip').addEventListener('click', () => {
    track('car_skip');
    close();
    go('postos');
  });
  $('c1-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const model = $<HTMLInputElement>('c1-model').value.trim().slice(0, 60);
    const err = $('c1-err');
    if (!model) {
      err.textContent = 'Digite o modelo, por exemplo "Onix 1.0".';
      err.hidden = false;
      return;
    }
    const km = parseIntLoose($<HTMLInputElement>('c1-km').value);
    const yr = model.match(/\b(19[5-9]\d|20\d\d)\b/);
    const fuel = (document.querySelector<HTMLInputElement>('input[name="c1-fuel"]:checked')?.value ?? 'flex') as VehicleFuel;
    const row = stamp<Vehicle>({
      id: uuid(),
      // apelido: o modelo sem o ano (dá para editar depois em Meu carro)
      name: (model.replace(/\b(19[5-9]\d|20\d\d)\b/, '').replace(/\s+/g, ' ').trim() || model).slice(0, 40),
      make: null,
      model,
      year: yr ? Number(yr[1]) : null,
      engine: null,
      fuel_type: fuel,
      initial_km: Number.isFinite(km) && km >= 0 ? km : null,
      plan_key: null,
      plan_custom: null,
      archived: 0,
    });
    await db.vehicles.put(row);
    await setMeta('current_vehicle', row.id);
    track('car_created');
    close();
    go('inicio');
    toast(row.name + ' cadastrado');
  });
}

function close() {
  $('v-boasvindas').hidden = true;
  document.body.classList.remove('welcoming');
}
