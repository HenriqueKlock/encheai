-- Anexo da OS em cada manutenção + bucket privado; cada usuário só lê e grava na própria pasta (<user_id>/...)
alter table public.services add column if not exists attachment_path text check (char_length(attachment_path) <= 200);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('os', 'os', false, 10485760, array['application/pdf','image/jpeg','image/png','image/webp','image/heic'])
on conflict (id) do nothing;

create policy "os: dono lê" on storage.objects for select to authenticated
  using (bucket_id = 'os' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "os: dono envia" on storage.objects for insert to authenticated
  with check (bucket_id = 'os' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "os: dono substitui" on storage.objects for update to authenticated
  using (bucket_id = 'os' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'os' and (storage.foldername(name))[1] = (select auth.uid())::text);
