-- Cota diária também para a nota pelo place_id (lugar) e para as avaliações do Google.
alter table public.api_usage drop constraint api_usage_fn_check;
alter table public.api_usage add constraint api_usage_fn_check check (fn = any (array['google_nearby', 'google_posto', 'google_address', 'google_photo', 'google_autocomplete', 'google_details', 'google_lugar', 'google_avaliacoes']));
