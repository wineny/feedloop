-- Supabase DB 스키마 초기화 마이그레이션

-- 1. users (next-auth 연동)
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT,
  email TEXT UNIQUE,
  email_verified TIMESTAMPTZ,
  image TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  refresh_token TEXT,
  access_token TEXT,
  expires_at INTEGER,
  token_type TEXT,
  scope TEXT,
  id_token TEXT,
  UNIQUE(provider, provider_account_id)
);

CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_token TEXT UNIQUE NOT NULL,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  expires TIMESTAMPTZ NOT NULL
);

-- 2. bots (사용자가 등록한 텔레그램 봇)
CREATE TABLE bots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- 텔레그램 봇 정보
  bot_token_encrypted TEXT NOT NULL,       -- AES-256-GCM 암호화
  bot_username TEXT,                       -- @xxx_bot
  telegram_user_id BIGINT,                 -- 봇 소유자의 TG ID (나중에 /link로 연결)

  -- 서비스 설정
  service_name TEXT NOT NULL,              -- "로나", "콕집이"
  service_description TEXT,                -- 서비스 한 줄 설명
  service_url TEXT,                        -- 서비스 URL (선택)

  -- 인터뷰 설정
  mention_patterns JSONB DEFAULT '[]',     -- ["로나", "@로나"]
  feedback_keywords JSONB DEFAULT '{}',    -- {negative: [...], positive: [...], question: [...]}

  -- LLM 설정
  llm_provider TEXT DEFAULT 'gemini',      -- gemini | anthropic | openai
  llm_api_key_encrypted TEXT,              -- null = 우리 기본 키 사용

  -- 쿨다운 설정
  cooldown_interval_sec INTEGER DEFAULT 30,
  cooldown_max_daily INTEGER DEFAULT 50,
  active_hours_start INTEGER DEFAULT 9,
  active_hours_end INTEGER DEFAULT 23,

  -- 상태
  status TEXT DEFAULT 'pending',           -- pending | active | paused | error
  status_message TEXT,                     -- 에러 시 상세 메시지
  last_active_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_bots_user ON bots(user_id);
CREATE INDEX idx_bots_status ON bots(status);

-- 3. messages (그룹 대화 메시지)
CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id UUID NOT NULL REFERENCES bots(id) ON DELETE CASCADE,

  telegram_message_id BIGINT,
  chat_id BIGINT,
  author_name TEXT NOT NULL,
  author_id BIGINT,
  body TEXT NOT NULL,

  detected_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),

  UNIQUE(bot_id, telegram_message_id)    -- 중복 방지
);

CREATE INDEX idx_msg_bot ON messages(bot_id);
CREATE INDEX idx_msg_detected ON messages(detected_at);

-- 4. insights (AI가 추출한 인사이트)
CREATE TABLE insights (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id UUID NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  message_id UUID REFERENCES messages(id) ON DELETE CASCADE,

  category TEXT NOT NULL,        -- bug | ux | feature_request | praise | cs | other
  summary TEXT NOT NULL,
  sentiment TEXT,                -- positive | neutral | negative
  follow_up_needed BOOLEAN DEFAULT false,

  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_ins_bot ON insights(bot_id);
CREATE INDEX idx_ins_created ON insights(created_at);
CREATE INDEX idx_ins_category ON insights(bot_id, category);

-- 5. responses (봇이 보낸 응답)
CREATE TABLE responses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id UUID NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  trigger_message_id UUID REFERENCES messages(id),

  response_type TEXT NOT NULL,   -- mention | keyword | question
  response_body TEXT NOT NULL,

  sent_at TIMESTAMPTZ DEFAULT now()
);

-- 6. cooldown_state (봇별 쿨다운)
CREATE TABLE cooldown_state (
  bot_id UUID PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE,
  last_response_at TIMESTAMPTZ,
  daily_response_count INTEGER DEFAULT 0,
  daily_count_date DATE
);

-- 7. feedbacks (기존 trae — 카카오톡 피드백 목업)
CREATE TABLE feedbacks (
  id SERIAL PRIMARY KEY,
  user_name TEXT NOT NULL,
  content TEXT NOT NULL,
  source TEXT DEFAULT 'kakao',
  type TEXT NOT NULL,
  bot_response TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 8. classifications (기존 trae — AI 분류)
CREATE TABLE classifications (
  id SERIAL PRIMARY KEY,
  feedback_id INTEGER REFERENCES feedbacks(id) UNIQUE,
  category TEXT NOT NULL,
  priority TEXT,
  reason TEXT,
  dev_instruction TEXT,
  classified_at TIMESTAMPTZ DEFAULT now()
);

-- 9. action_logs (기존 trae — 자동 개발 로그)
CREATE TABLE action_logs (
  id SERIAL PRIMARY KEY,
  classification_id INTEGER REFERENCES classifications(id),
  action TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  details TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Row Level Security (RLS)

-- 사용자는 자기 봇만 볼 수 있음
ALTER TABLE bots ENABLE ROW LEVEL SECURITY;
CREATE POLICY bots_owner ON bots FOR ALL USING (user_id = auth.uid());

-- 메시지/인사이트/응답은 봇 소유자만 (서브쿼리 사용)
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY messages_owner ON messages FOR ALL
  USING (bot_id IN (SELECT id FROM bots WHERE user_id = auth.uid()));

-- (insights와 responses에도 동일한 패턴으로 적용)
ALTER TABLE insights ENABLE ROW LEVEL SECURITY;
CREATE POLICY insights_owner ON insights FOR ALL
  USING (bot_id IN (SELECT id FROM bots WHERE user_id = auth.uid()));

ALTER TABLE responses ENABLE ROW LEVEL SECURITY;
CREATE POLICY responses_owner ON responses FOR ALL
  USING (bot_id IN (SELECT id FROM bots WHERE user_id = auth.uid()));
