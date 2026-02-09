-- Create leads table to store lead master data (migrated from Google Sheets)
create table if not exists leads (
  id uuid primary key default gen_random_uuid(),
  lead_id text unique,
  lead_name text,
  phone_e164 text not null,
  email text,
  property_id text,
  property_name text,
  property_address text,
  property_price_inr text,
  property_beds_baths text,
  property_highlights text,
  showing_windows text,
  property_url text,
  call_status text default 'queued',
  call_attempts int default 0,
  last_call_at timestamptz,
  bland_call_id text,
  bolna_execution_id text,
  call_provider text,
  outcome text,
  next_action text,
  notes text,
  transcript text,
  recording_url text,
  summary text,
  voice_id text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Indexes for common queries
create index if not exists leads_phone_e164_idx on leads(phone_e164);
create index if not exists leads_lead_id_idx on leads(lead_id);
create index if not exists leads_call_status_idx on leads(call_status);
create index if not exists leads_outcome_idx on leads(outcome);
create index if not exists leads_bolna_execution_id_idx on leads(bolna_execution_id);
create index if not exists leads_bland_call_id_idx on leads(bland_call_id);

-- Add missing columns to calls table
alter table calls add column if not exists bolna_execution_id text;
alter table calls add column if not exists call_provider text;

-- Create index on bolna_execution_id for calls (for upsert)
create index if not exists calls_bolna_execution_id_idx on calls(bolna_execution_id);

-- Updated_at trigger function
create or replace function update_updated_at_column()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

-- Apply trigger to leads table
drop trigger if exists leads_updated_at on leads;
create trigger leads_updated_at
  before update on leads
  for each row
  execute function update_updated_at_column();
