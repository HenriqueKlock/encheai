-- Sugestões de endereço enquanto digita (Places Autocomplete) e o detalhe do lugar escolhido também contam na cota diária
alter table public.api_usage drop constraint api_usage_fn_check;
alter table public.api_usage add constraint api_usage_fn_check check (fn in ('google_nearby', 'google_posto', 'google_address', 'google_photo', 'google_autocomplete', 'google_details'));
