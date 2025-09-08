-- players: tekil kullanıcı
create table if not exists players (
  id bigserial primary key,
  google_sub text unique,
  pgs_player_id text unique,
  display_name text,
  country_code text,
  coins int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_login_at timestamptz
);

-- ilerleme: mod başına tek satır (upsert)
create type if not exists game_mode as enum ('classic4','size5','size6','time60');

create table if not exists progress (
  player_id bigint not null references players(id) on delete cascade,
  mode game_mode not null,
  best_score int not null default 0,
  best_tile int not null default 0,
  games_played int not null default 0,
  total_moves bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (player_id, mode)
);

-- tek tek maç geçmişi
create table if not exists runs (
  id bigserial primary key,
  player_id bigint not null references players(id) on delete cascade,
  mode game_mode not null,
  score int not null,
  max_tile int not null,
  duration_ms bigint,
  moves int,
  created_at timestamptz not null default now()
);

-- coin hareketleri
create table if not exists coin_ledger (
  id bigserial primary key,
  player_id bigint not null references players(id) on delete cascade,
  delta int not null,
  reason text,
  created_at timestamptz not null default now()
);
