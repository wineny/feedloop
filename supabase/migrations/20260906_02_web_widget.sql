-- 웹 위젯 → 받은편지함 → 묶음 PR → 되돌림
-- 설계: docs/07-위젯/웹-위젯-루프-설계.md §4
--
-- 기존 카카오·텔레그램 경로와 대시보드 통계를 건드리지 않도록 **추가만** 한다.
-- messages = 유저가 보낸 것, responses = 우리가 보낸 것 이라는 기존 구분은 그대로 두고
-- conversation_id 로 묶어 타임라인을 만든다.

-- ── 대화 단위 ────────────────────────────────────────
-- 웹 위젯 방문자 1명 = 대화 1개, 카카오 유저 1명 = 대화 1개

CREATE TABLE conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id UUID NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  source TEXT NOT NULL,                 -- web | kakao | telegram
  external_user_id TEXT NOT NULL,       -- visitorId | botUserKey | chat_id
  contact_name TEXT,
  contact_email TEXT,
  contact_phone TEXT,
  status TEXT NOT NULL DEFAULT 'open',  -- open | closed
  last_message_at TIMESTAMPTZ,
  operator_read_at TIMESTAMPTZ,         -- 받은편지함 미읽음 판정
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (bot_id, source, external_user_id)
);

ALTER TABLE messages  ADD COLUMN conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE;
ALTER TABLE responses ADD COLUMN conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE;

-- NULL 이면 아직 유저에게 못 보낸 것 = 카카오 대기열.
-- 운영자 답장과 되돌림이 같은 큐를 쓴다.
ALTER TABLE responses ADD COLUMN delivered_at TIMESTAMPTZ;
ALTER TABLE responses ADD COLUMN auto_dev_run_id UUID REFERENCES auto_dev_runs(id) ON DELETE SET NULL;
-- response_type 값 추가: ai | operator | loop_closed (기존 mention|keyword|question|kakao 유지)

-- ── 피드백 묶음 ──────────────────────────────────────
-- 비슷한 피드백을 묶어 묶음당 PR 1개를 만든다

CREATE TABLE insight_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id UUID NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  title TEXT NOT NULL,                  -- "쿠폰 페이지에서 적용 버튼이 안 눌림"
  summary TEXT NOT NULL,                -- PR 프롬프트에 들어갈 종합 설명
  category TEXT NOT NULL,               -- insights.category 와 같은 값
  status TEXT NOT NULL DEFAULT 'open',  -- open | pr_created | merged | dismissed
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE insights      ADD COLUMN group_id UUID REFERENCES insight_groups(id) ON DELETE SET NULL;
ALTER TABLE auto_dev_runs ADD COLUMN group_id UUID REFERENCES insight_groups(id) ON DELETE SET NULL;
ALTER TABLE auto_dev_runs ADD COLUMN merged_at TIMESTAMPTZ;

-- ── 봇 설정 ─────────────────────────────────────────

ALTER TABLE bots ADD COLUMN pr_mode TEXT NOT NULL DEFAULT 'approve';  -- approve | auto
ALTER TABLE bots ADD COLUMN widget_connected_at TIMESTAMPTZ;

-- ── 인덱스 ──────────────────────────────────────────

CREATE INDEX idx_conv_bot_last ON conversations(bot_id, last_message_at DESC);
CREATE INDEX idx_msg_conv ON messages(conversation_id);
CREATE INDEX idx_resp_conv ON responses(conversation_id);
-- 카카오 웹훅이 매 발화마다 때리는 경로 — 미전달분만 인덱싱한다
CREATE INDEX idx_resp_undelivered ON responses(conversation_id) WHERE delivered_at IS NULL;
CREATE INDEX idx_insight_group ON insights(group_id);
CREATE INDEX idx_group_bot ON insight_groups(bot_id, status);

-- ── RLS ─────────────────────────────────────────────
-- 기존 테이블과 같은 패턴: 봇 소유자만. 라우트는 service_role 을 쓰므로 우회되지만,
-- anon 키로 직접 REST 를 때리는 경로를 막는다.

ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
CREATE POLICY conversations_owner ON conversations FOR ALL
  USING (bot_id IN (SELECT id FROM bots WHERE user_id = auth.uid()));

ALTER TABLE insight_groups ENABLE ROW LEVEL SECURITY;
CREATE POLICY insight_groups_owner ON insight_groups FOR ALL
  USING (bot_id IN (SELECT id FROM bots WHERE user_id = auth.uid()));

-- ── 기존 데이터 백필 ────────────────────────────────
--
-- 이미 들어와 있는 카카오 실데이터(메시지 4·응답 4)가 받은편지함과 타임라인에서
-- 사라지지 않도록 대화에 연결한다. 시연이 이 실데이터 위에서 돈다.

-- 1) 기존 메시지의 (봇, 채널, 외부유저) 조합마다 대화를 만든다
INSERT INTO conversations (bot_id, source, external_user_id, last_message_at, created_at)
SELECT
  m.bot_id,
  m.source,
  m.external_user_id,
  MAX(m.detected_at),
  MIN(m.detected_at)
FROM messages m
WHERE m.external_user_id IS NOT NULL
GROUP BY m.bot_id, m.source, m.external_user_id
ON CONFLICT (bot_id, source, external_user_id) DO NOTHING;

-- 2) 메시지를 대화에 연결
UPDATE messages m
SET conversation_id = c.id
FROM conversations c
WHERE m.conversation_id IS NULL
  AND m.external_user_id IS NOT NULL
  AND c.bot_id = m.bot_id
  AND c.source = m.source
  AND c.external_user_id = m.external_user_id;

-- 3) 응답을 트리거 메시지를 통해 같은 대화에 연결
UPDATE responses r
SET conversation_id = m.conversation_id
FROM messages m
WHERE r.conversation_id IS NULL
  AND r.trigger_message_id = m.id
  AND m.conversation_id IS NOT NULL;

-- 4) **중요** — 기존 응답은 이미 유저에게 나간 것이다.
--    delivered_at 을 채우지 않으면 새로 생긴 미전달 인덱스가 이것들을 대기열로 보고,
--    그 유저가 다음에 말을 걸 때 옛날 답변이 한꺼번에 쏟아진다.
UPDATE responses
SET delivered_at = COALESCE(sent_at, now())
WHERE delivered_at IS NULL;
