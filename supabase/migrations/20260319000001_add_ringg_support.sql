-- Add Ringg AI call tracking columns to leads and calls tables

-- Leads: ringg_call_id for webhook correlation
alter table leads add column if not exists ringg_call_id text;
create index if not exists leads_ringg_call_id_idx on leads(ringg_call_id);

-- Calls: ringg_call_id for upsert/tracking (parallel to bolna_execution_id)
alter table calls add column if not exists ringg_call_id text;
create unique index if not exists calls_ringg_call_id_unique on calls(ringg_call_id) where ringg_call_id is not null;
