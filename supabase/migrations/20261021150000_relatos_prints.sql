-- Prints anexados aos relatos: bucket privado sem políticas para usuários (só a função `relato`,
-- com a chave de serviço, grava; só o dono do projeto vê, pelo painel). Até 3 imagens por relato.
alter table public.feedback add column attachments text[] not null default '{}'
  check (cardinality(attachments) <= 3);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('relatos', 'relatos', false, 3145728, array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;
