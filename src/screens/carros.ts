// Carros: escolher o carro atual, cadastrar, editar e arquivar.
import { db, setMeta, stamp, uuid, type Vehicle, type VehicleFuel } from '../db';
import { parseIntLoose } from '../calc';
import { S, activeVehicles, current } from '../store';
import { $, closeSheets, esc, openSheet, toast } from '../ui';
import { track } from '../uso';

export function initCarros() {
  function openCars() {
    if (!activeVehicles().length) return openVehicle(null);
    const cur = current();
    $('car-list').innerHTML = activeVehicles()
      .map((v) => {
        const sub = [v.make, v.model, v.year, v.engine].filter(Boolean).join(' · ');
        return '<div class="car-row' + (cur && v.id === cur.id ? ' current' : '') + '"><button type="button" class="car-pick" data-pick="' + esc(v.id) + '"><span class="radio"></span><span><div class="nm">' + esc(v.name) + '</div><div class="sub">' + esc(sub || 'Sem detalhes') + '</div></span></button><button type="button" class="link-btn" data-edit="' + esc(v.id) + '">Editar</button></div>';
      })
      .join('');
    openSheet('car-sheet');
  }
  $('car-list').addEventListener('click', async (e) => {
    const el = e.target as HTMLElement;
    const edit = el.closest<HTMLElement>('[data-edit]');
    const pick = el.closest<HTMLElement>('[data-pick]');
    if (edit) return openVehicle(edit.dataset.edit!);
    if (pick) {
      await setMeta('current_vehicle', pick.dataset.pick);
      closeSheets();
    }
  });
  $('car-add').addEventListener('click', () => openVehicle(null));

  let editingVehicle: Vehicle | null = null;
  let archArmed = false;
  let afterSave: (() => void) | null = null;
  function openVehicle(id: string | null, then?: () => void) {
    afterSave = then ?? null;
    editingVehicle = id ? S.vehicles.find((v) => v.id === id) ?? null : null;
    archArmed = false;
    const ev = editingVehicle;
    $('vehicle-title').textContent = ev ? 'Editar carro' : 'Cadastrar carro';
    const set = (i: string, val: unknown) => ($<HTMLInputElement>(i).value = val == null ? '' : String(val));
    set('v-name', ev?.name);
    set('v-make', ev?.make);
    set('v-model', ev?.model);
    set('v-year', ev?.year);
    set('v-engine', ev?.engine);
    set('v-fuel', ev?.fuel_type ?? 'flex');
    set('v-km', ev?.initial_km);
    $('v-err').hidden = true;
    const arch = $('v-archive');
    arch.hidden = !ev;
    arch.classList.remove('armed');
    arch.textContent = 'Arquivar carro';
    openSheet('vehicle-sheet');
    setTimeout(() => $('v-name').focus({ preventScroll: true }), 260);
  }
  $('v-archive').addEventListener('click', async () => {
    if (!editingVehicle) return;
    if (!archArmed) {
      archArmed = true;
      $('v-archive').classList.add('armed');
      $('v-archive').textContent = 'Confirmar: arquivar ' + editingVehicle.name;
      return;
    }
    await db.vehicles.put(stamp<Vehicle>({ ...editingVehicle, archived: 1 }));
    closeSheets();
    toast(editingVehicle.name + ' arquivado; o histórico continua guardado.');
  });
  $('vehicle-sheet').addEventListener('submit', async (e) => {
    e.preventDefault();
    const val = (i: string) => $<HTMLInputElement>(i).value.trim();
    const name = val('v-name').slice(0, 40);
    if (!name) {
      $('v-err').textContent = 'Dê um apelido ao carro, por exemplo "Creta".';
      $('v-err').hidden = false;
      return;
    }
    const year = parseIntLoose(val('v-year'));
    const ikm = parseIntLoose(val('v-km'));
    const row = stamp<Vehicle>({
      id: editingVehicle?.id ?? uuid(),
      name,
      make: val('v-make').slice(0, 40) || null,
      model: val('v-model').slice(0, 60) || null,
      year: Number.isFinite(year) && year >= 1900 && year <= 2100 ? year : null,
      engine: val('v-engine').slice(0, 40) || null,
      fuel_type: val('v-fuel') as VehicleFuel,
      initial_km: Number.isFinite(ikm) ? ikm : null,
      plan_key: editingVehicle?.plan_key ?? null,
      plan_custom: editingVehicle?.plan_custom ?? null,
      archived: 0,
    });
    await db.vehicles.put(row);
    if (!editingVehicle) { await setMeta('current_vehicle', row.id); track('car_created'); }
    const next = editingVehicle ? null : afterSave;
    afterSave = null;
    closeSheets(next ?? undefined);
    toast(editingVehicle ? 'Carro atualizado' : name + ' cadastrado');
  });

  document.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('[data-act="cars"]')) openCars();
  });
  return { openCars, openVehicle };
}
