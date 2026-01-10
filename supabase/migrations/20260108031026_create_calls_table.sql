create table if not exists calls (
  id uuid primary key default gen_random_uuid(),
  lead_id text,
  property_id text,
  phone_e164 text,
  bland_call_id text unique,
  status text,
  outcome text,
  next_action text,
  attempt int,
  started_at timestamptz,
  ended_at timestamptz,
  duration_sec int,
  transcript text,
  recording_url text,
  raw_webhook jsonb,
  created_at timestamptz default now()
);

create index if not exists calls_lead_id_idx on calls(lead_id);
create index if not exists calls_property_id_idx on calls(property_id);

