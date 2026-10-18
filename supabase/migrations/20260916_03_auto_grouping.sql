-- I-10 자동 묶기 + I-11 대화 힌트 (2026-09-16)
--
-- 자동 묶기는 크론이 아니라(Hobby 는 하루 1회 크론 2개가 끝) 인사이트가 settle 된 요청의
-- after() 안에서 돈다. 판정은 전부 DB 시계(now())로 — 서버리스 인스턴스마다 시계가 조금씩 달라
-- JS Date 로 비교하면 경계에서 어긋난다. 봇당 상태는 grouping_revisions 한 행에 산다.
--
--   due_at      : 이 시각이 지나면 묶어도 된다. 제보가 이어지면 앞으로 밀린다(trailing debounce).
--                 단 first_requested_at + max_wait 를 넘지 못한다 — 80초마다 제보가 오는 봇도 언젠가는 묶인다.
--   waiter_until: 「기다리는 사람」 슬롯. 요청마다 90초를 자면 무인증 요청 하나가 함수를 90초씩 잡는다(보안 리뷰 H2).
--                 슬롯을 먼저 잡은 요청 하나만 자고, 나머지는 due 만 밀고 즉시 돌아간다.
--   lock_until/lock_token : 실행 잠금 + 펜싱. 만료 뒤 남이 잡은 잠금을 옛 실행이 풀지 못한다(보안 리뷰 M2).
--   grouped_at  : 마지막 «성공» 시각. 실패는 여기 안 찍힌다.

-- 1차판(ee7bc5d, 프로덕션엔 적용된 적 없음)의 시그니처. claim 은 반환형이 boolean→uuid 라 CREATE OR REPLACE 가
-- 거부하고(42P13), request/release 는 인자 수가 달라 오버로드로 남으면 호출이 모호해진다. 먼저 지운다.
DROP FUNCTION IF EXISTS auto_grouping_request(uuid, integer);
DROP FUNCTION IF EXISTS auto_grouping_claim(uuid, boolean, integer);
DROP FUNCTION IF EXISTS auto_grouping_release(uuid);

ALTER TABLE grouping_revisions ADD COLUMN IF NOT EXISTS auto_group_due_at timestamptz;
ALTER TABLE grouping_revisions ADD COLUMN IF NOT EXISTS auto_group_first_requested_at timestamptz;
ALTER TABLE grouping_revisions ADD COLUMN IF NOT EXISTS auto_group_waiter_until timestamptz;
ALTER TABLE grouping_revisions ADD COLUMN IF NOT EXISTS auto_group_lock_until timestamptz;
ALTER TABLE grouping_revisions ADD COLUMN IF NOT EXISTS auto_group_lock_token uuid;
ALTER TABLE grouping_revisions ADD COLUMN IF NOT EXISTS auto_grouped_at timestamptz;

-- 요청: 「이 봇은 quiet 초 뒤에 묶어야 한다」 + 대기자 선출.
-- 돌려주는 값: due(예정 시각) · waiter(이 호출이 대기자가 됐는가) · waiter_until(대기자 슬롯 값, 해제 때 펜싱용).
CREATE OR REPLACE FUNCTION auto_grouping_request(
  p_bot_id uuid,
  p_quiet_seconds integer DEFAULT 90,
  p_max_wait_seconds integer DEFAULT 600,
  p_waiter_seconds integer DEFAULT 300
) RETURNS jsonb LANGUAGE plpgsql SET search_path=public AS $$
DECLARE r grouping_revisions; first_at timestamptz; due timestamptz; elected boolean; slot timestamptz;
BEGIN
  INSERT INTO grouping_revisions(bot_id) VALUES (p_bot_id) ON CONFLICT DO NOTHING;
  SELECT * INTO r FROM grouping_revisions WHERE bot_id = p_bot_id FOR UPDATE;
  -- 예정이 없던 상태에서 온 첫 요청이 «이번 회차»의 시작이다. 클레임이 due 를 비우면 다음 회차가 새로 센다.
  first_at := CASE WHEN r.auto_group_due_at IS NULL THEN now() ELSE coalesce(r.auto_group_first_requested_at, now()) END;
  due := least(now() + make_interval(secs => greatest(p_quiet_seconds, 0)),
               first_at + make_interval(secs => greatest(p_max_wait_seconds, 1)));
  elected := r.auto_group_waiter_until IS NULL OR r.auto_group_waiter_until < now();
  slot := CASE WHEN elected THEN now() + make_interval(secs => greatest(p_waiter_seconds, 1)) ELSE r.auto_group_waiter_until END;
  UPDATE grouping_revisions
     SET auto_group_due_at = due, auto_group_first_requested_at = first_at, auto_group_waiter_until = slot
   WHERE bot_id = p_bot_id;
  RETURN jsonb_build_object('due', due, 'waiter', elected, 'waiter_until', slot);
END $$;

-- 대기자 슬롯 반납. 자기 슬롯 값일 때만 — 만료 뒤 새로 뽑힌 대기자의 슬롯을 옛 대기자가 지우지 않는다.
CREATE OR REPLACE FUNCTION auto_grouping_waiter_release(p_bot_id uuid, p_waiter_until timestamptz)
RETURNS boolean LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  UPDATE grouping_revisions SET auto_group_waiter_until = NULL
   WHERE bot_id = p_bot_id AND auto_group_waiter_until = p_waiter_until;
  RETURN FOUND;
END $$;

-- 클레임: due 가 지났고(또는 p_require_due=false) 잠금이 없거나 만료됐으면 잠그고 토큰을 준다. 아니면 NULL.
-- due 와 회차 시작을 비우는 것도 여기서 — 같은 요청을 두 번 실행하지 않는다. 대기자 슬롯도 비운다(일은 지금 하니까).
CREATE OR REPLACE FUNCTION auto_grouping_claim(p_bot_id uuid, p_require_due boolean DEFAULT true, p_lock_seconds integer DEFAULT 150)
RETURNS uuid LANGUAGE plpgsql SET search_path=public AS $$
DECLARE token uuid := gen_random_uuid();
BEGIN
  INSERT INTO grouping_revisions(bot_id) VALUES (p_bot_id) ON CONFLICT DO NOTHING;
  UPDATE grouping_revisions
     SET auto_group_lock_until = now() + make_interval(secs => greatest(p_lock_seconds, 1)),
         auto_group_lock_token = token,
         auto_group_due_at = NULL,
         auto_group_first_requested_at = NULL,
         auto_group_waiter_until = NULL
   WHERE bot_id = p_bot_id
     AND (auto_group_lock_until IS NULL OR auto_group_lock_until < now())
     AND (NOT p_require_due OR (auto_group_due_at IS NOT NULL AND auto_group_due_at <= now()));
  IF FOUND THEN RETURN token; END IF;
  RETURN NULL;
END $$;

-- 해제: 자기 토큰일 때만 잠금을 푼다. 성공이면 grouped_at 을 찍고, 실패면 due 를 다시 심는다(재무장) —
-- 클레임이 due 를 비웠으므로 여기서 안 심으면 실패한 봇은 다음 제보나 사람 손이 올 때까지 영영 안 묶인다(리뷰 3건이 같은 지적).
-- 그사이 새 제보가 due 를 이미 심었으면 그 값을 존중한다.
CREATE OR REPLACE FUNCTION auto_grouping_release(p_bot_id uuid, p_token uuid, p_ok boolean DEFAULT true, p_retry_seconds integer DEFAULT 600)
RETURNS boolean LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  UPDATE grouping_revisions
     SET auto_group_lock_until = NULL,
         auto_group_lock_token = NULL,
         auto_grouped_at = CASE WHEN p_ok THEN now() ELSE auto_grouped_at END,
         auto_group_due_at = CASE WHEN p_ok THEN auto_group_due_at
                                  ELSE coalesce(auto_group_due_at, now() + make_interval(secs => greatest(p_retry_seconds, 1))) END,
         auto_group_first_requested_at = CASE WHEN p_ok THEN auto_group_first_requested_at
                                              ELSE coalesce(auto_group_first_requested_at, now()) END
   WHERE bot_id = p_bot_id AND auto_group_lock_token = p_token;
  RETURN FOUND;
END $$;

-- I-11: 같은 대화의 제보는 이어 말한 것일 가능성이 높다 — 모델이 그걸 볼 수 있게 대화 id 를 싣는다.
-- 시그니처 불변 → 기존 GRANT 유지. 스냅샷의 나머지 로직은 20260913_10 그대로.
CREATE OR REPLACE FUNCTION pipeline_group_snapshot(p_bot_id uuid,p_limit integer DEFAULT 40)
RETURNS jsonb LANGUAGE plpgsql SET search_path=public AS $$
DECLARE rev bigint; existing jsonb; candidates jsonb; pending integer;
BEGIN
 INSERT INTO grouping_revisions(bot_id) VALUES(p_bot_id) ON CONFLICT DO NOTHING;
 SELECT revision INTO rev FROM grouping_revisions WHERE bot_id=p_bot_id FOR UPDATE;
 IF (SELECT count(*) FROM insight_groups WHERE bot_id=p_bot_id)>500 THEN RAISE EXCEPTION 'grouping_capacity_requires_partition'; END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(g)),'[]') INTO existing FROM (SELECT id,title,summary,category,status FROM insight_groups WHERE bot_id=p_bot_id ORDER BY created_at,id) g;
 SELECT count(*) INTO pending FROM insights WHERE bot_id=p_bot_id AND group_id IS NULL AND category IN ('bug','ux','feature_request');
 SELECT coalesce(jsonb_agg(to_jsonb(i)),'[]') INTO candidates FROM (
   SELECT i.id, i.category, i.summary, m.conversation_id
     FROM insights i LEFT JOIN messages m ON m.id = i.message_id
    WHERE i.bot_id=p_bot_id AND i.group_id IS NULL AND i.category IN ('bug','ux','feature_request')
    ORDER BY i.created_at, i.id LIMIT least(greatest(p_limit,1),40)) i;
 RETURN jsonb_build_object('revision',rev,'existing',existing,'insights',candidates,'pending',pending);
END $$;

-- Supabase 는 새 함수에 anon·authenticated EXECUTE 를 기본 부여한다(20260913_26 교훈). 넷 다 회수.
REVOKE ALL ON FUNCTION
  auto_grouping_request(uuid,integer,integer,integer),
  auto_grouping_waiter_release(uuid,timestamptz),
  auto_grouping_claim(uuid,boolean,integer),
  auto_grouping_release(uuid,uuid,boolean,integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  auto_grouping_request(uuid,integer,integer,integer),
  auto_grouping_waiter_release(uuid,timestamptz),
  auto_grouping_claim(uuid,boolean,integer),
  auto_grouping_release(uuid,uuid,boolean,integer)
  TO service_role;

NOTIFY pgrst, 'reload schema';
