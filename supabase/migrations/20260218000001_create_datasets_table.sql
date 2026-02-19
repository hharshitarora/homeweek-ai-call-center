-- Dataset library: one row per CSV upload
create table if not exists datasets (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  source_filename text,
  uploaded_by text,
  uploaded_at timestamptz not null default now(),
  row_count int not null default 0,
  status text not null default 'active',
  notes text,
  created_at timestamptz not null default now()
);

create index if not exists datasets_uploaded_at_idx on datasets(uploaded_at desc);
create index if not exists datasets_status_idx on datasets(status);

alter table leads add column if not exists dataset_id uuid references datasets(id) on delete set null;
alter table leads add column if not exists source_row_number int;

create index if not exists leads_dataset_id_idx on leads(dataset_id);
