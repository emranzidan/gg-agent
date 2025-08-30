-- migrations/001_init.sql — core schema (append-only events + order snapshot)

create table if not exists orders (
  ref                   text primary key,
  created_at_utc        timestamptz not null default now(),

  -- state & key timestamps
  status                text not null default 'AWAITING_PAYMENT', -- AWAITING_PAYMENT|AWAITING_RECEIPT|AWAITING_REVIEW|APPROVED|DISPATCHING|ASSIGNED|OUT_FOR_DELIVERY|DELIVERED|REJECTED|ABANDONED
  approved_at_utc       timestamptz,
  driver_accepted_at_utc timestamptz,
  picked_at_utc         timestamptz,
  delivered_at_utc      timestamptz,
  rejected_at_utc       timestamptz,
  fail_reason           text, -- rejected | abandoned_no_receipt | abandoned_no_payment_choice

  -- customer & location
  customer_name         text,
  phone                 text,
  email                 text,
  address               text,
  map_url               text,
  area                  text,
  distance_km           numeric(6,2),
  pickup_location       text,

  -- payment & totals
  payment_method        text, -- TELEBIRR | BANK | —
  goods_subtotal_etb    integer,
  delivery_fee_etb      integer,
  total_etb             integer,
  qty_total             integer,

  -- driver snapshot (no driver_id by request)
  driver_name           text,
  driver_phone          text,

  -- raw inputs
  raw_summary           text not null,
  items_json            jsonb not null default '[]'::jsonb
);

create index if not exists idx_orders_status on orders(status);
create index if not exists idx_orders_created on orders(created_at_utc);
create index if not exists idx_orders_approved on orders(approved_at_utc);

-- Optional normalized items (handy for analytics)
create table if not exists order_items (
  ref           text not null,
  item_seq      int not null,
  roast         text,
  type          text,
  size_g        int,
  qty           int,
  unit_price    int,
  line_total    int,
  primary key (ref, item_seq),
  foreign key (ref) references orders(ref) on delete cascade
);

-- Append-only event log (audit)
create table if not exists order_events (
  id            bigserial primary key,
  ref           text not null,
  at_utc        timestamptz not null default now(),
  event         text not null, -- intake|payment_selected|receipt_posted|approved|rejected|dispatching|assigned|picked|delivered|abandoned
  meta          jsonb not null default '{}'::jsonb
);
create index if not exists idx_events_ref on order_events(ref);

-- Block updates/deletes on order_events (append-only)
create or replace function forbid_event_mutation() returns trigger as $$
begin
  if (TG_OP = 'UPDATE' or TG_OP = 'DELETE') then
    raise exception 'order_events is append-only';
  end if;
  return null;
end;
$$ language plpgsql;

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_forbid_events_ud') then
    create trigger trg_forbid_events_ud
    before update or delete on order_events
    for each statement execute function forbid_event_mutation();
  end if;
end$$;
