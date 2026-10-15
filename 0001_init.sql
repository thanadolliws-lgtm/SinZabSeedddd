-- =============================================================================
-- 0001_init.sql — Sinsap personal finance & investment schema
-- Works on PostgreSQL 15+ (Supabase / Neon / self-hosted) and on PGlite.
--
-- Access model
--   * The application connects as the table owner (e.g. `postgres`).
--   * Every request that touches user data runs inside a transaction that does
--       SET LOCAL ROLE app_user;  SELECT set_config('app.user_id', '<uuid>', true);
--     `app_user` has no BYPASSRLS, so the RLS policies below are enforced by the
--     database itself, not only by WHERE clauses in application code.
--   * Auth tables and shared market-data tables have RLS enabled with NO policy
--     and no grants to app_user: only the owner (server-side system code) can
--     touch them. This also keeps Supabase's public Data API (anon key) locked out.
-- =============================================================================

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_user') then
    create role app_user nologin;
  end if;
end $$;

grant app_user to current_user;

create or replace function app_current_user_id() returns uuid
language sql stable
as $$ select nullif(current_setting('app.user_id', true), '')::uuid $$;

-- -----------------------------------------------------------------------------
-- Auth (owner-only)
-- -----------------------------------------------------------------------------
create table users (
  id                  uuid primary key default gen_random_uuid(),
  email               text not null,
  password_hash       text not null,
  created_at          timestamptz not null default now(),
  password_changed_at timestamptz not null default now()
);
create unique index users_email_lower_idx on users (lower(email));

create table sessions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  token_hash   text not null unique,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  last_seen_at timestamptz not null default now(),
  user_agent   text
);
create index sessions_user_idx on sessions (user_id);

create table password_reset_tokens (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at    timestamptz
);

-- Sliding-window rate limiting for login / register / reset.
create table auth_attempts (
  id         bigserial primary key,
  key        text not null,
  kind       text not null,
  created_at timestamptz not null default now()
);
create index auth_attempts_lookup_idx on auth_attempts (kind, key, created_at);

-- -----------------------------------------------------------------------------
-- User-owned tables
-- -----------------------------------------------------------------------------
create table profiles (
  user_id      uuid primary key references users(id) on delete cascade,
  display_name text not null default '',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table user_settings (
  user_id                   uuid primary key references users(id) on delete cascade,
  base_currency             text not null default 'THB',
  timezone                  text not null default 'Asia/Bangkok',
  theme                     text not null default 'system' check (theme in ('system','light','dark')),
  emergency_months          integer not null default 6 check (emergency_months between 1 and 60),
  -- null = derive from recorded essential expenses
  essential_monthly_expense numeric(20,4) check (essential_monthly_expense is null or essential_monthly_expense >= 0),
  max_position_pct          numeric(7,4) not null default 25 check (max_position_pct between 1 and 100),
  max_category_pct          numeric(7,4) not null default 40 check (max_category_pct between 1 and 100),
  allocation_drift_pct      numeric(7,4) not null default 5 check (allocation_drift_pct between 0.5 and 100),
  stale_quote_hours         integer not null default 72 check (stale_quote_hours between 1 and 720),
  high_interest_rate        numeric(7,4) not null default 15 check (high_interest_rate between 0 and 100),
  due_soon_days             integer not null default 7 check (due_soon_days between 0 and 60),
  disabled_alerts           jsonb not null default '[]'::jsonb,
  updated_at                timestamptz not null default now()
);

create table savings_goals (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references users(id) on delete cascade,
  name                 text not null,
  target_amount        numeric(20,4) not null check (target_amount > 0),
  target_date          date,
  monthly_contribution numeric(20,4) not null default 0 check (monthly_contribution >= 0),
  status               text not null default 'active' check (status in ('active','achieved','paused')),
  note                 text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (user_id, id)
);

-- Cash, bank, brokerage-cash and manually valued "other asset" accounts.
-- purpose: general = spendable, emergency = emergency fund, goal = earmarked for a savings goal.
create table accounts (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references users(id) on delete cascade,
  name            text not null,
  type            text not null check (type in ('cash','bank','brokerage','other_asset')),
  purpose         text not null default 'general' check (purpose in ('general','emergency','goal')),
  goal_id         uuid,
  currency        text not null default 'THB',
  opening_balance numeric(20,4) not null default 0,
  opening_date    date not null,
  note            text,
  is_archived     boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (user_id, id),
  foreign key (user_id, goal_id) references savings_goals (user_id, id) on delete set null (goal_id)
);
create index accounts_user_idx on accounts (user_id);

create table securities (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references users(id) on delete cascade,
  symbol          text not null,
  exchange        text not null,
  name            text not null,
  asset_type      text not null default 'stock' check (asset_type in ('stock','etf','fund','other')),
  category        text not null default 'Other',
  asset_group     text,
  currency        text not null,
  manual_price    numeric(20,6) check (manual_price is null or manual_price > 0),
  manual_price_at timestamptz,
  note            text,
  is_archived     boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (user_id, id),
  unique (user_id, symbol, exchange)
);

create table portfolios (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(id) on delete cascade,
  name       text not null,
  kind       text not null check (kind in ('main','dca')),
  created_at timestamptz not null default now(),
  unique (user_id, id),
  unique (user_id, kind)
);

-- Investment ledger. Holdings, cost basis and P/L are always derived from these rows.
--   buy/sell   : quantity > 0, price >= 0, amount = quantity * price (gross), fee = commission
--   dividend   : amount = gross dividend, fee = withholding tax / charges
--   fee        : amount = standalone fee (custody, ADR fee ...)
--   split      : split_ratio = new shares per old share (4 = 4-for-1, 0.1 = 1-for-10)
--   adjustment : quantity = signed share delta, amount = signed cost-basis delta
-- fx_rate = units of base currency (THB) per 1 unit of `currency` on trade_date.
create table transactions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references users(id) on delete cascade,
  portfolio_id    uuid not null,
  security_id     uuid not null,
  account_id      uuid,
  type            text not null check (type in ('buy','sell','dividend','fee','split','adjustment')),
  trade_date      date not null,
  quantity        numeric(24,8),
  price           numeric(20,6) check (price is null or price >= 0),
  amount          numeric(20,4) not null default 0,
  fee             numeric(20,4) not null default 0 check (fee >= 0),
  split_ratio     numeric(20,8) check (split_ratio is null or split_ratio > 0),
  currency        text not null,
  fx_rate         numeric(20,8) not null default 1 check (fx_rate > 0),
  note            text,
  source          text not null default 'manual' check (source in ('manual','dca','import','watchlist')),
  idempotency_key text,
  import_hash     text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (user_id, id),
  unique (user_id, idempotency_key),
  foreign key (user_id, portfolio_id) references portfolios (user_id, id),
  foreign key (user_id, security_id)  references securities (user_id, id),
  foreign key (user_id, account_id)   references accounts (user_id, id),
  check (type not in ('buy','sell') or (quantity is not null and quantity > 0 and price is not null)),
  check (type <> 'split' or split_ratio is not null),
  check (type <> 'adjustment' or quantity is not null)
);
create index transactions_user_date_idx on transactions (user_id, trade_date, created_at);
create index transactions_security_idx on transactions (user_id, security_id);

-- Planned investments. Never affects holdings until a real transaction is confirmed.
create table watchlists (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references users(id) on delete cascade,
  security_id      uuid not null,
  target_price     numeric(20,6) check (target_price is null or target_price > 0),
  budget           numeric(20,4) check (budget is null or budget >= 0),
  planned_quantity numeric(24,8) check (planned_quantity is null or planned_quantity >= 0),
  reason           text,
  planned_date     date,
  priority         text not null default 'medium' check (priority in ('high','medium','low')),
  status           text not null default 'interested' check (status in ('interested','waiting','bought','cancelled')),
  transaction_id   uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (user_id, id),
  foreign key (user_id, security_id)    references securities (user_id, id) on delete cascade,
  foreign key (user_id, transaction_id) references transactions (user_id, id) on delete set null (transaction_id)
);

-- DCA: the PLAN (dca_plans + dca_allocations + dca_schedule) is separate from
-- EXECUTION (rows in `transactions` with source = 'dca', linked from dca_schedule).
create table dca_plans (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references users(id) on delete cascade,
  portfolio_id     uuid not null,
  name             text not null,
  -- monthly/daily: budget per month. weekly: budget per week.
  budget_amount    numeric(20,4) not null check (budget_amount > 0),
  budget_currency  text not null default 'THB',
  frequency        text not null default 'monthly' check (frequency in ('monthly','weekly','daily')),
  invest_day       integer check (invest_day is null or invest_day between 1 and 31),
  days_per_month   integer check (days_per_month is null or days_per_month between 1 and 31),
  start_date       date not null,
  duration_months  integer check (duration_months is null or duration_months between 1 and 1200),
  risk_level       text not null default 'medium' check (risk_level in ('low','medium','high')),
  objective        text not null default 'balanced' check (objective in ('growth','dividend','balanced')),
  min_investment   numeric(20,4) not null default 0 check (min_investment >= 0),
  fee_pct          numeric(8,4) not null default 0 check (fee_pct >= 0),
  fee_min          numeric(20,4) not null default 0 check (fee_min >= 0),
  allow_fractional boolean not null default true,
  -- draft = saved with allocation total <> 100% after explicit confirmation; cannot generate a schedule
  status           text not null default 'active' check (status in ('draft','active','paused')),
  note             text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (user_id, id),
  foreign key (user_id, portfolio_id) references portfolios (user_id, id)
);

create table dca_allocations (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  plan_id     uuid not null,
  security_id uuid not null,
  target_pct  numeric(7,4) not null check (target_pct >= 0 and target_pct <= 100),
  unique (plan_id, security_id),
  foreign key (user_id, plan_id)     references dca_plans (user_id, id) on delete cascade,
  foreign key (user_id, security_id) references securities (user_id, id)
);

create table dca_schedule (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references users(id) on delete cascade,
  plan_id        uuid not null,
  security_id    uuid not null,
  planned_date   date not null,
  planned_amount numeric(20,4) not null check (planned_amount >= 0),
  currency       text not null default 'THB',
  status         text not null default 'planned' check (status in ('planned','executed','skipped')),
  transaction_id uuid,
  note           text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (plan_id, security_id, planned_date),
  foreign key (user_id, plan_id)        references dca_plans (user_id, id) on delete cascade,
  foreign key (user_id, security_id)    references securities (user_id, id),
  foreign key (user_id, transaction_id) references transactions (user_id, id) on delete set null (transaction_id)
);
create index dca_schedule_user_date_idx on dca_schedule (user_id, planned_date);

-- Income / expenses / debt are recorded in the base currency (THB).
create table income_records (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references users(id) on delete cascade,
  account_id      uuid,
  income_date     date not null,
  type            text not null check (type in ('salary','extra','side_job','bonus','dividend','other')),
  source          text,
  amount          numeric(20,4) not null check (amount > 0),
  status          text not null default 'received' check (status in ('expected','received')),
  note            text,
  idempotency_key text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (user_id, idempotency_key),
  foreign key (user_id, account_id) references accounts (user_id, id)
);
create index income_user_date_idx on income_records (user_id, income_date);

create table recurring_expenses (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users(id) on delete cascade,
  account_id    uuid,
  name          text not null,
  category      text not null,
  amount        numeric(20,4) not null check (amount > 0),
  frequency     text not null check (frequency in ('daily','weekly','monthly','yearly')),
  next_due_date date not null,
  end_date      date,
  is_essential  boolean not null default false,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (user_id, id),
  foreign key (user_id, account_id) references accounts (user_id, id)
);

create table expense_records (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references users(id) on delete cascade,
  account_id      uuid,
  recurring_id    uuid,
  -- date the expense occurred (paid) or is due (unpaid)
  expense_date    date not null,
  category        text not null,
  description     text,
  amount          numeric(20,4) not null check (amount > 0),
  frequency       text not null default 'once' check (frequency in ('once','daily','weekly','monthly','yearly')),
  is_essential    boolean not null default false,
  status          text not null default 'paid' check (status in ('paid','unpaid')),
  paid_date       date,
  note            text,
  idempotency_key text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (user_id, idempotency_key),
  unique (recurring_id, expense_date),
  foreign key (user_id, account_id)   references accounts (user_id, id),
  foreign key (user_id, recurring_id) references recurring_expenses (user_id, id) on delete set null (recurring_id),
  check (status <> 'paid' or paid_date is not null)
);
create index expense_user_date_idx on expense_records (user_id, expense_date);

create table liabilities (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references users(id) on delete cascade,
  name            text not null,
  kind            text not null default 'other'
                  check (kind in ('credit_card','personal_loan','mortgage','auto_loan','student_loan','informal','other')),
  opening_balance numeric(20,4) not null check (opening_balance >= 0),
  opening_date    date not null,
  annual_rate     numeric(8,4) not null default 0 check (annual_rate >= 0 and annual_rate <= 1000),
  min_payment     numeric(20,4) not null default 0 check (min_payment >= 0),
  due_day         integer check (due_day is null or due_day between 1 and 31),
  target_payment  numeric(20,4) check (target_payment is null or target_payment >= 0),
  status          text not null default 'active' check (status in ('active','closed')),
  note            text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (user_id, id)
);

-- kind = payment: money paid to the creditor. kind = charge: additional borrowing / new spending on the debt.
-- interest_amount: actual interest charged for the period if known (from the statement);
--                  null = let the system estimate from annual_rate (simple daily accrual).
create table debt_payments (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references users(id) on delete cascade,
  liability_id    uuid not null,
  account_id      uuid,
  kind            text not null default 'payment' check (kind in ('payment','charge')),
  pay_date        date not null,
  amount          numeric(20,4) not null check (amount > 0),
  interest_amount numeric(20,4) check (interest_amount is null or interest_amount >= 0),
  fee_amount      numeric(20,4) not null default 0 check (fee_amount >= 0),
  note            text,
  idempotency_key text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (user_id, idempotency_key),
  foreign key (user_id, liability_id) references liabilities (user_id, id) on delete cascade,
  foreign key (user_id, account_id)   references accounts (user_id, id)
);
create index debt_payments_user_date_idx on debt_payments (user_id, pay_date);

-- Movement between the user's own accounts. Never an income or an expense.
create table transfers (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references users(id) on delete cascade,
  from_account_id uuid not null,
  to_account_id   uuid not null,
  transfer_date   date not null,
  amount_from     numeric(20,4) not null check (amount_from > 0),
  amount_to       numeric(20,4) not null check (amount_to > 0),
  fee             numeric(20,4) not null default 0 check (fee >= 0),
  kind            text not null default 'transfer'
                  check (kind in ('transfer','emergency_allocation','goal_allocation','investment_funding')),
  note            text,
  idempotency_key text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (user_id, idempotency_key),
  foreign key (user_id, from_account_id) references accounts (user_id, id),
  foreign key (user_id, to_account_id)   references accounts (user_id, id),
  check (from_account_id <> to_account_id)
);
create index transfers_user_date_idx on transfers (user_id, transfer_date);

create table monthly_budgets (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(id) on delete cascade,
  month      text not null check (month ~ '^\d{4}-\d{2}$'),
  category   text not null,
  amount     numeric(20,4) not null check (amount >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, month, category)
);

-- Monthly allocation plan. `items` is a small fixed list of
-- { key, mode: 'amount'|'percent', value } rows, stored as JSON because it is
-- always read and written as one unit and never queried row-by-row.
create table allocation_plans (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  month        text not null check (month ~ '^\d{4}-\d{2}$'),
  basis        text not null default 'received' check (basis in ('received','received_and_expected')),
  basis_amount numeric(20,4) not null default 0,
  items        jsonb not null default '[]'::jsonb,
  status       text not null default 'draft' check (status in ('draft','confirmed')),
  confirmed_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (user_id, month)
);

-- Append-only audit trail for financial records (app_user may only INSERT and SELECT).
create table audit_log (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(id) on delete cascade,
  action     text not null check (action in ('create','update','delete','import','confirm')),
  entity     text not null,
  entity_id  text,
  before     jsonb,
  after      jsonb,
  created_at timestamptz not null default now()
);
create index audit_user_time_idx on audit_log (user_id, created_at desc);

-- -----------------------------------------------------------------------------
-- Shared market data (owner-only; contains no personal data)
-- -----------------------------------------------------------------------------
create table market_quotes (
  symbol     text not null,
  exchange   text not null,
  price      numeric(20,6) not null,
  prev_close numeric(20,6),
  open       numeric(20,6),
  high       numeric(20,6),
  low        numeric(20,6),
  volume     numeric(24,2),
  change     numeric(20,6),
  change_pct numeric(12,6),
  currency   text,
  -- as_of = the time the PROVIDER says the price is for; fetched_at = when we called the provider
  as_of      timestamptz not null,
  data_type  text not null check (data_type in ('realtime','delayed','eod')),
  source     text not null,
  fetched_at timestamptz not null default now(),
  primary key (symbol, exchange)
);

create table price_history (
  symbol     text not null,
  exchange   text not null,
  price_date date not null,
  open       numeric(20,6),
  high       numeric(20,6),
  low        numeric(20,6),
  close      numeric(20,6) not null,
  volume     numeric(24,2),
  source     text not null,
  primary key (symbol, exchange, price_date)
);

create table price_history_meta (
  symbol     text not null,
  exchange   text not null,
  fetched_at timestamptz not null,
  source     text not null,
  primary key (symbol, exchange)
);

create table security_fundamentals (
  symbol     text not null,
  exchange   text not null,
  data       jsonb not null,
  source     text not null,
  fetched_at timestamptz not null default now(),
  primary key (symbol, exchange)
);

-- rate = units of `quote` per 1 unit of `base` (e.g. base USD, quote THB, rate 36.5)
create table exchange_rates (
  base       text not null,
  quote      text not null,
  rate_date  date not null,
  rate       numeric(20,8) not null check (rate > 0),
  source     text not null,
  fetched_at timestamptz not null default now(),
  primary key (base, quote, rate_date)
);

-- Outbound provider calls, used to enforce per-minute / per-day quotas.
create table api_usage (
  id        bigserial primary key,
  provider  text not null,
  endpoint  text not null,
  ok        boolean not null,
  error     text,
  called_at timestamptz not null default now()
);
create index api_usage_lookup_idx on api_usage (provider, called_at);

-- -----------------------------------------------------------------------------
-- Row Level Security
-- -----------------------------------------------------------------------------
do $$
declare
  t text;
  user_tables text[] := array[
    'profiles','user_settings','savings_goals','accounts','securities','portfolios','transactions',
    'watchlists','dca_plans','dca_allocations','dca_schedule','income_records','recurring_expenses',
    'expense_records','liabilities','debt_payments','transfers','monthly_budgets','allocation_plans','audit_log'
  ];
  locked_tables text[] := array[
    'users','sessions','password_reset_tokens','auth_attempts',
    'market_quotes','price_history','price_history_meta','security_fundamentals','exchange_rates','api_usage'
  ];
begin
  foreach t in array user_tables loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format(
      'create policy %I on %I for all to app_user using (user_id = app_current_user_id()) with check (user_id = app_current_user_id())',
      t || '_owner', t);
    if t = 'audit_log' then
      execute format('grant select, insert on %I to app_user', t);
    else
      execute format('grant select, insert, update, delete on %I to app_user', t);
    end if;
  end loop;

  foreach t in array locked_tables loop
    execute format('alter table %I enable row level security', t);
  end loop;
end $$;
