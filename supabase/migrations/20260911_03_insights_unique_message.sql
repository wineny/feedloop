-- 한 메시지에 인사이트는 하나.
--
-- 왜 필요한가 — 배치 분류(`/api/classify`)는 「이미 분류됐는가」를 읽고 나서 insert 하는데
-- 그 사이에 원자성이 없다. 화면 버튼은 `setClassifying(true)` 로 잠기지만 탭 두 개나
-- 새로고침이면 두 실행이 같은 미분류 목록을 보고 둘 다 저장한다.
-- 중복이 생기면 묶기에서 같은 제보가 두 번 세어지고, 시연 숫자가 틀어진다.
--
-- `validateClassifications` 는 **한 호출 안의** 중복만 막는다. 호출 사이는 DB 가 막아야 한다.
--
-- 부분 인덱스인 이유: `message_id` 는 nullable 이다(메시지 없이 만들어지는 인사이트가
-- 있을 수 있고, 메시지가 지워지면 ON DELETE CASCADE 로 행도 같이 사라지지만
-- 스키마상 NULL 이 허용된다). NULL 끼리는 UNIQUE 가 충돌하지 않지만, 의도를 분명히 한다.
--
-- 적용 시점 기준 중복 0건 — `select message_id, count(*) from insights group by 1 having count(*)>1` 이 빈 결과.

CREATE UNIQUE INDEX IF NOT EXISTS insights_message_id_unique
  ON insights (message_id)
  WHERE message_id IS NOT NULL;
