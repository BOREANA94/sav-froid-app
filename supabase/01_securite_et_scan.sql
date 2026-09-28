-- =====================================================================
-- SAV Froid – étape 1 : techniciens, suivi des bouteilles, sécurité
-- À exécuter UNE fois dans Supabase > SQL Editor, APRÈS la création
-- des tables bottles et movements. Le script peut être relancé sans risque.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Profils : nom affiché + rôle (technicien ou admin)
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  full_name  text,
  role       text not null default 'technicien',
  created_at timestamptz not null default now(),
  constraint profiles_role_check check (role in ('technicien', 'admin'))
);

-- Un profil est créé automatiquement pour chaque nouveau compte
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name)
  values (
    new.id,
    coalesce(nullif(new.raw_user_meta_data ->> 'full_name', ''), split_part(new.email, '@', 1))
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Profils pour les comptes qui existent déjà
insert into public.profiles (id, full_name)
select id, split_part(email, '@', 1) from auth.users
on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- 2. Bouteilles : qui l'a actuellement + valeurs autorisées
-- ---------------------------------------------------------------------
alter table public.bottles
  add column if not exists current_technician_id uuid references public.profiles(id) on delete set null;

alter table public.bottles alter column status set not null;
alter table public.bottles drop constraint if exists bottles_status_check;
alter table public.bottles add constraint bottles_status_check
  check (status in ('en_stock', 'chez_technicien', 'vide', 'maintenance'));

create index if not exists bottles_current_technician_idx on public.bottles (current_technician_id);

-- ---------------------------------------------------------------------
-- 3. Mouvements : valeurs autorisées + lien vers le profil (pour afficher le nom)
-- ---------------------------------------------------------------------
alter table public.movements alter column bottle_id set not null;
alter table public.movements alter column technician_id set not null;
alter table public.movements drop constraint if exists movements_action_check;
alter table public.movements add constraint movements_action_check
  check (action in ('checkout', 'checkin'));

alter table public.movements drop constraint if exists movements_technician_profile_fkey;
alter table public.movements add constraint movements_technician_profile_fkey
  foreign key (technician_id) references public.profiles(id);

create index if not exists movements_bottle_idx on public.movements (bottle_id, created_at desc);
create index if not exists movements_technician_idx on public.movements (technician_id, created_at desc);

-- ---------------------------------------------------------------------
-- 4. Sécurité (RLS) : il faut être connecté pour voir quoi que ce soit
-- ---------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;

alter table public.profiles  enable row level security;
alter table public.bottles   enable row level security;
alter table public.movements enable row level security;

-- Profils : lecture par les connectés, modification par un admin seulement
drop policy if exists "profiles_lecture" on public.profiles;
create policy "profiles_lecture" on public.profiles
  for select to authenticated using (true);

drop policy if exists "profiles_admin_modif" on public.profiles;
create policy "profiles_admin_modif" on public.profiles
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- Bouteilles : lecture par les connectés, gestion par un admin
drop policy if exists "bottles_lecture" on public.bottles;
create policy "bottles_lecture" on public.bottles
  for select to authenticated using (true);

drop policy if exists "bottles_admin_ajout" on public.bottles;
create policy "bottles_admin_ajout" on public.bottles
  for insert to authenticated with check (public.is_admin());

drop policy if exists "bottles_admin_modif" on public.bottles;
create policy "bottles_admin_modif" on public.bottles
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "bottles_admin_suppr" on public.bottles;
create policy "bottles_admin_suppr" on public.bottles
  for delete to authenticated using (public.is_admin());

-- Mouvements : lecture par les connectés. Les techniciens n'écrivent jamais
-- directement : tout passe par la fonction scan_bottle ci-dessous.
drop policy if exists "movements_lecture" on public.movements;
create policy "movements_lecture" on public.movements
  for select to authenticated using (true);

-- ---------------------------------------------------------------------
-- 5. Scan d'une bouteille : prise (checkout) ou retour au stock (checkin)
-- ---------------------------------------------------------------------
create or replace function public.scan_bottle(
  p_bottle_id text,
  p_action    text,
  p_note      text default null
)
returns public.bottles
language plpgsql
security definer
set search_path = public
as $$
declare
  b public.bottles;
begin
  if auth.uid() is null then
    raise exception 'Vous devez être connecté.';
  end if;
  if p_action not in ('checkout', 'checkin') then
    raise exception 'Action inconnue : %', p_action;
  end if;

  select * into b from public.bottles where id = upper(trim(p_bottle_id)) for update;
  if not found then
    raise exception 'Bouteille % inconnue.', p_bottle_id;
  end if;

  if p_action = 'checkout' then
    if b.current_technician_id = auth.uid() then
      raise exception 'La bouteille % est déjà dans votre camion.', b.id;
    end if;
    update public.bottles
       set status = 'chez_technicien', current_technician_id = auth.uid()
     where id = b.id
     returning * into b;
  else
    if b.current_technician_id is null then
      raise exception 'La bouteille % est déjà au stock.', b.id;
    end if;
    if b.current_technician_id <> auth.uid() and not public.is_admin() then
      raise exception 'La bouteille % n''est pas dans votre camion.', b.id;
    end if;
    update public.bottles
       set status = 'en_stock', current_technician_id = null
     where id = b.id
     returning * into b;
  end if;

  insert into public.movements (bottle_id, technician_id, action, note)
  values (b.id, auth.uid(), p_action, nullif(trim(p_note), ''));

  return b;
end;
$$;

-- ---------------------------------------------------------------------
-- 6. Création de bouteilles avec numéro unique BTL-0001, BTL-0002… (admin)
-- ---------------------------------------------------------------------
create sequence if not exists public.bottle_number_seq;

create or replace function public.create_bottles(
  p_count       int,
  p_gas_type    text,
  p_capacity_kg numeric
)
returns setof public.bottles
language plpgsql
security definer
set search_path = public
as $$
declare
  i      int;
  new_id text;
begin
  if not public.is_admin() then
    raise exception 'Réservé aux administrateurs.';
  end if;
  if p_count is null or p_count < 1 or p_count > 200 then
    raise exception 'Nombre de bouteilles entre 1 et 200.';
  end if;

  for i in 1 .. p_count loop
    loop
      new_id := 'BTL-' || lpad(nextval('public.bottle_number_seq')::text, 4, '0');
      exit when not exists (select 1 from public.bottles where id = new_id);
    end loop;
    return query
      insert into public.bottles (id, gas_type, capacity_kg, status)
      values (new_id, nullif(upper(trim(p_gas_type)), ''), p_capacity_kg, 'en_stock')
      returning *;
  end loop;
end;
$$;

-- Seuls les utilisateurs connectés peuvent appeler ces fonctions
revoke execute on function public.scan_bottle(text, text, text) from public, anon;
grant  execute on function public.scan_bottle(text, text, text) to authenticated;
revoke execute on function public.create_bottles(int, text, numeric) from public, anon;
grant  execute on function public.create_bottles(int, text, numeric) to authenticated;
revoke execute on function public.is_admin() from public, anon;
grant  execute on function public.is_admin() to authenticated;
