create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  full_name text not null default '',
  role text not null default 'member' check (role in ('member', 'admin')),
  active boolean not null default true,
  loan_limit numeric(14, 2) not null default 0 check (loan_limit >= 0),
  created_at timestamptz not null default now()
);

create table public.loan_applications (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.profiles (id),
  requested_amount numeric(14, 2) not null check (requested_amount > 0),
  purpose text not null check (length(trim(purpose)) between 3 and 1000),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  approved_amount numeric(14, 2),
  decision_note text,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid references public.profiles (id),
  check (approved_amount is null or approved_amount > 0)
);

create unique index one_pending_application_per_member
  on public.loan_applications (member_id) where status = 'pending';

create table public.loans (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null unique references public.loan_applications (id),
  member_id uuid not null references public.profiles (id),
  principal numeric(14, 2) not null check (principal > 0),
  outstanding_principal numeric(14, 2) not null check (outstanding_principal >= 0),
  accrued_interest numeric(14, 2) not null default 0 check (accrued_interest >= 0),
  interest_rate numeric(7, 4) not null check (interest_rate between 0 and 100),
  status text not null default 'active' check (status in ('active', 'closed')),
  disbursed_at timestamptz not null default now(),
  last_interest_at timestamptz not null default now(),
  created_by uuid not null references public.profiles (id),
  check (outstanding_principal <= principal)
);

create table public.transactions (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.profiles (id),
  loan_id uuid references public.loans (id),
  transaction_type text not null check (transaction_type in ('deposit', 'disbursement', 'repayment')),
  amount numeric(14, 2) not null check (amount > 0),
  principal_component numeric(14, 2) not null default 0 check (principal_component >= 0),
  interest_component numeric(14, 2) not null default 0 check (interest_component >= 0),
  reference text not null default '',
  description text not null default '',
  created_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now(),
  check (
    (transaction_type = 'deposit' and loan_id is null and principal_component = 0 and interest_component = 0)
    or (transaction_type = 'disbursement' and loan_id is not null and principal_component = amount and interest_component = 0)
    or (transaction_type = 'repayment' and loan_id is not null and principal_component + interest_component = amount)
  )
);

create index transactions_member_created_idx on public.transactions (member_id, created_at desc);
create index transactions_loan_created_idx on public.transactions (loan_id, created_at desc);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.profiles (id),
  title text not null,
  message text not null,
  created_at timestamptz not null default now(),
  read_at timestamptz
);

create index notifications_member_created_idx on public.notifications (member_id, created_at desc);

create table public.audit_log (
  id bigint generated always as identity primary key,
  actor_id uuid references public.profiles (id),
  action text not null,
  entity_type text not null,
  entity_id text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create or replace function public.is_kosh_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = (select auth.uid()) and role = 'admin' and active
  );
$$;

create or replace function public.is_active_kosh_user()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = (select auth.uid()) and active
  );
$$;

create or replace function public.create_profile_for_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data ->> 'full_name', split_part(coalesce(new.email, ''), '@', 1))
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created_profile
  after insert on auth.users
  for each row execute function public.create_profile_for_auth_user();

create or replace function public.reject_ledger_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'Posted ledger entries cannot be changed or deleted. Post a correcting transaction instead.';
end;
$$;

create trigger transactions_are_append_only
  before update or delete on public.transactions
  for each row execute function public.reject_ledger_mutation();

create or replace function public.write_audit_log()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  entity_key text;
  audit_action text;
begin
  if tg_table_name = 'transactions' then
    entity_key := new.id::text;
    audit_action := 'transaction.posted:' || new.transaction_type;
    insert into public.audit_log (actor_id, action, entity_type, entity_id, details)
    values (new.created_by, audit_action, 'transaction', entity_key,
      jsonb_build_object('member_id', new.member_id, 'amount', new.amount, 'loan_id', new.loan_id, 'reference', new.reference));
    return new;
  end if;

  entity_key := new.id::text;
  audit_action := case when tg_op = 'INSERT' then 'loan_application.submitted' else 'loan_application.' || new.status end;
  insert into public.audit_log (actor_id, action, entity_type, entity_id, details)
  values (
    case when tg_op = 'INSERT' then new.member_id else coalesce(new.decided_by, new.member_id) end,
    audit_action,
    'loan_application',
    entity_key,
    jsonb_build_object('member_id', new.member_id, 'requested_amount', new.requested_amount, 'approved_amount', new.approved_amount, 'status', new.status)
  );
  return new;
end;
$$;

create trigger audit_transaction_posts
  after insert on public.transactions
  for each row execute function public.write_audit_log();

create trigger audit_loan_application_changes
  after insert or update of status on public.loan_applications
  for each row execute function public.write_audit_log();

create or replace function public.reject_audit_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'Audit log entries are immutable.';
end;
$$;

create trigger audit_log_is_immutable
  before update or delete on public.audit_log
  for each row execute function public.reject_audit_mutation();

alter table public.profiles enable row level security;
alter table public.loan_applications enable row level security;
alter table public.loans enable row level security;
alter table public.transactions enable row level security;
alter table public.notifications enable row level security;
alter table public.audit_log enable row level security;

create policy "profiles_read_self_or_admin" on public.profiles
  for select to authenticated using ((id = (select auth.uid()) and (select public.is_active_kosh_user())) or (select public.is_kosh_admin()));
create policy "applications_read_self_or_admin" on public.loan_applications
  for select to authenticated using ((member_id = (select auth.uid()) and (select public.is_active_kosh_user())) or (select public.is_kosh_admin()));
create policy "loans_read_self_or_admin" on public.loans
  for select to authenticated using ((member_id = (select auth.uid()) and (select public.is_active_kosh_user())) or (select public.is_kosh_admin()));
create policy "transactions_read_self_or_admin" on public.transactions
  for select to authenticated using ((member_id = (select auth.uid()) and (select public.is_active_kosh_user())) or (select public.is_kosh_admin()));
create policy "notifications_read_self_or_admin" on public.notifications
  for select to authenticated using ((member_id = (select auth.uid()) and (select public.is_active_kosh_user())) or (select public.is_kosh_admin()));
create policy "audit_read_admin_only" on public.audit_log
  for select to authenticated using ((select public.is_kosh_admin()));

revoke all on public.profiles, public.loan_applications, public.loans, public.transactions, public.notifications, public.audit_log from anon, authenticated;
grant select on public.profiles, public.loan_applications, public.loans, public.transactions, public.notifications, public.audit_log to authenticated;
revoke all on function public.is_kosh_admin() from public, anon;
revoke all on function public.is_active_kosh_user() from public, anon;
grant execute on function public.is_kosh_admin(), public.is_active_kosh_user() to authenticated;

create or replace function public.get_cash_balance()
returns numeric
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  current_balance numeric;
begin
  if not public.is_kosh_admin() then raise exception 'Administrator access required.'; end if;
  select coalesce(sum(case when transaction_type in ('deposit', 'repayment') then amount else -amount end), 0)
    into current_balance from public.transactions;
  return current_balance;
end;
$$;

create or replace function public.get_my_deposit_total()
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(sum(amount), 0)
  from public.transactions
  where member_id = (select auth.uid()) and transaction_type = 'deposit';
$$;

create or replace function public.submit_loan_application(p_amount numeric, p_purpose text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  applicant public.profiles%rowtype;
  application_id uuid;
  active_loan_total numeric;
begin
  select * into applicant from public.profiles where id = auth.uid() for update;
  if not found or not applicant.active or applicant.role <> 'member' then raise exception 'Active member account required.'; end if;
  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2) then raise exception 'Enter a valid positive amount with at most two decimal places.'; end if;
  select coalesce(sum(outstanding_principal), 0) into active_loan_total
    from public.loans where member_id = applicant.id and status = 'active';
  if active_loan_total + p_amount > applicant.loan_limit then
    raise exception 'The request would exceed your total active loan limit of Rs. %.', applicant.loan_limit;
  end if;
  if length(trim(coalesce(p_purpose, ''))) not between 3 and 1000 then raise exception 'Provide a purpose between 3 and 1000 characters.'; end if;
  insert into public.loan_applications (member_id, requested_amount, purpose)
    values (applicant.id, p_amount, trim(p_purpose)) returning id into application_id;
  insert into public.notifications (member_id, title, message)
    select id, 'Loan application received', applicant.full_name || ' submitted an application for Rs. ' || p_amount || '.'
    from public.profiles where role = 'admin' and active;
  return application_id;
end;
$$;

create or replace function public.record_deposit(
  p_member_id uuid,
  p_amount numeric,
  p_reference text default '',
  p_description text default ''
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.profiles%rowtype;
  transaction_id uuid;
begin
  if not public.is_kosh_admin() then raise exception 'Administrator access required.'; end if;
  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2) then raise exception 'Deposit amount must be positive and have at most two decimal places.'; end if;
  select * into target from public.profiles where id = p_member_id and role = 'member';
  if not found then raise exception 'Choose a member account.'; end if;
  insert into public.transactions (member_id, transaction_type, amount, reference, description, created_by)
    values (target.id, 'deposit', p_amount, left(coalesce(p_reference, ''), 120), left(coalesce(p_description, ''), 300), auth.uid())
    returning id into transaction_id;
  insert into public.notifications (member_id, title, message)
    values (target.id, 'Deposit posted', 'A deposit of Rs. ' || p_amount || ' was posted to your Kosh account.');
  return transaction_id;
end;
$$;

create or replace function public.decide_loan_application(
  p_application_id uuid,
  p_approve boolean,
  p_decision_note text default ''
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  application public.loan_applications%rowtype;
  borrower public.profiles%rowtype;
  new_loan_id uuid;
  available_cash numeric;
  active_loan_total numeric;
begin
  if not public.is_kosh_admin() then raise exception 'Administrator access required.'; end if;
  perform pg_advisory_xact_lock(hashtext('ashtamangal-kosh-fund-balance'));
  select * into application from public.loan_applications where id = p_application_id for update;
  if not found or application.status <> 'pending' then raise exception 'This application is no longer pending.'; end if;
  select * into borrower from public.profiles where id = application.member_id for update;
  if not found or not borrower.active then raise exception 'The member account is no longer active.'; end if;
  if not p_approve and length(trim(coalesce(p_decision_note, ''))) < 3 then raise exception 'Provide a rejection reason of at least 3 characters.'; end if;
  if p_approve then
    select coalesce(sum(outstanding_principal), 0) into active_loan_total
      from public.loans where member_id = borrower.id and status = 'active';
    if active_loan_total + application.requested_amount > borrower.loan_limit then
      raise exception 'Approval would exceed the member''s total active loan limit.';
    end if;
    select coalesce(sum(case when transaction_type in ('deposit', 'repayment') then amount else -amount end), 0)
      into available_cash from public.transactions;
    if available_cash < application.requested_amount then raise exception 'Insufficient recorded cash for this disbursement.'; end if;
    insert into public.loans (application_id, member_id, principal, outstanding_principal, interest_rate, created_by)
      values (application.id, borrower.id, application.requested_amount, application.requested_amount, 12, auth.uid())
      returning id into new_loan_id;
    insert into public.transactions (member_id, loan_id, transaction_type, amount, principal_component, created_by, description)
      values (borrower.id, new_loan_id, 'disbursement', application.requested_amount, application.requested_amount, auth.uid(), 'Approved loan disbursement');
    update public.loan_applications
      set status = 'approved', approved_amount = application.requested_amount,
          decision_note = nullif(left(trim(coalesce(p_decision_note, '')), 1000), ''),
          decided_at = now(), decided_by = auth.uid()
      where id = application.id;
    insert into public.notifications (member_id, title, message)
      values (borrower.id, 'Loan approved and disbursed', 'Your loan of Rs. ' || application.requested_amount || ' has been approved and disbursed.');
    return new_loan_id;
  end if;
  update public.loan_applications
    set status = 'rejected', decision_note = left(trim(p_decision_note), 1000),
        decided_at = now(), decided_by = auth.uid()
    where id = application.id;
  insert into public.notifications (member_id, title, message)
    values (borrower.id, 'Loan application update', 'Your loan application was not approved. Board note: ' || left(trim(p_decision_note), 500));
  return null;
end;
$$;

create or replace function public.record_repayment(
  p_loan_id uuid,
  p_amount numeric,
  p_allocation text default 'interest-first',
  p_reference text default ''
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.loans%rowtype;
  payment_interest numeric(14, 2);
  payment_principal numeric(14, 2);
  interest_due numeric(14, 2);
  next_principal numeric(14, 2);
  next_interest numeric(14, 2);
  transaction_id uuid;
begin
  if not public.is_kosh_admin() then raise exception 'Administrator access required.'; end if;
  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2) then raise exception 'Repayment must be positive and have at most two decimal places.'; end if;
  if p_allocation not in ('interest-first', 'principal-first') then raise exception 'Choose interest-first or principal-first allocation.'; end if;
  select * into target from public.loans where id = p_loan_id and status = 'active' for update;
  if not found then raise exception 'Active loan not found.'; end if;
  interest_due := round(target.accrued_interest + target.outstanding_principal * target.interest_rate / 100
    * greatest(0, extract(epoch from (now() - target.last_interest_at))) / 31536000, 2);
  if p_amount > target.outstanding_principal + interest_due then raise exception 'Payment exceeds the calculated loan balance of Rs. %.', target.outstanding_principal + interest_due; end if;
  if p_allocation = 'interest-first' then
    payment_interest := least(p_amount, interest_due);
    payment_principal := p_amount - payment_interest;
  else
    payment_principal := least(p_amount, target.outstanding_principal);
    payment_interest := p_amount - payment_principal;
  end if;
  next_principal := target.outstanding_principal - payment_principal;
  next_interest := interest_due - payment_interest;
  update public.loans
    set outstanding_principal = next_principal,
        accrued_interest = next_interest,
        last_interest_at = now(),
        status = case when next_principal = 0 and next_interest = 0 then 'closed' else 'active' end
    where id = target.id;
  insert into public.transactions (
    member_id, loan_id, transaction_type, amount, principal_component, interest_component, reference, created_by
  ) values (
    target.member_id, target.id, 'repayment', p_amount, payment_principal, payment_interest,
    left(coalesce(p_reference, ''), 120), auth.uid()
  ) returning id into transaction_id;
  insert into public.notifications (member_id, title, message)
    values (target.member_id, 'Loan repayment posted', 'A repayment of Rs. ' || p_amount || ' was posted to your loan.');
  return transaction_id;
end;
$$;

create or replace function public.update_member_settings(p_member_id uuid, p_full_name text, p_loan_limit numeric, p_active boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_kosh_admin() then raise exception 'Administrator access required.'; end if;
  if length(trim(coalesce(p_full_name, ''))) not between 2 and 120 then raise exception 'Member name must be between 2 and 120 characters.'; end if;
  if p_loan_limit is null or p_loan_limit < 0 or p_loan_limit <> round(p_loan_limit, 2) then raise exception 'Loan limit must be zero or greater, with at most two decimal places.'; end if;
  update public.profiles
    set full_name = trim(p_full_name), loan_limit = p_loan_limit, active = p_active
    where id = p_member_id and role = 'member';
  if not found then raise exception 'Member account not found.'; end if;
  insert into public.audit_log (actor_id, action, entity_type, entity_id, details)
    values (auth.uid(), 'member.settings_updated', 'profile', p_member_id::text,
      jsonb_build_object('full_name', trim(p_full_name), 'loan_limit', p_loan_limit, 'active', p_active));
  if not p_active then
    insert into public.notifications (member_id, title, message)
      values (p_member_id, 'Account access changed', 'Your Kosh portal account has been deactivated. Contact the board for assistance.');
  end if;
end;
$$;

revoke all on function public.get_cash_balance(), public.get_my_deposit_total(),
  public.submit_loan_application(numeric, text), public.record_deposit(uuid, numeric, text, text),
  public.decide_loan_application(uuid, boolean, text), public.record_repayment(uuid, numeric, text, text),
  public.update_member_settings(uuid, text, numeric, boolean) from public, anon;
grant execute on function public.get_cash_balance(), public.get_my_deposit_total(),
  public.submit_loan_application(numeric, text), public.record_deposit(uuid, numeric, text, text),
  public.decide_loan_application(uuid, boolean, text), public.record_repayment(uuid, numeric, text, text),
  public.update_member_settings(uuid, text, numeric, boolean) to authenticated;
