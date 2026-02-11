-- Login attempts audit log: one row per OTP request; verified updated when user completes login
create table if not exists login_attempts (
  id uuid primary key default gen_random_uuid(),
  username text not null,
  email_sent boolean not null default false,
  verified boolean not null default false,
  created_at timestamptz default now()
);

create index if not exists login_attempts_username_idx on login_attempts(username);
create index if not exists login_attempts_created_at_idx on login_attempts(created_at desc);
