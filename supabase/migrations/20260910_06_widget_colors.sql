-- 위젯 색상 2개 — 운영자가 고르는 강조색·내 말풍선색.
--
-- 20260906_03_widget_appearance.sql 의 "봇 설정 › 위젯 모양" 확장이다.
-- 지금까지 위젯(public/widget.js)은 Feedloop 코랄 #F2645C 과 잉크 #191d1b 를
-- 박아 쓰고 있었다 — 고객 사이트에 붙는 물건인데 우리 브랜드색이 뜬다.
--
-- 둘 다 NULL 허용이고 NULL = 지금까지의 기본색이다. 기존 봇은 아무것도 안 바뀐다.
-- 값은 항상 소문자 #rrggbb 로 정규화해서 넣는다(lib/bot/appearance.ts).
-- 코랄 틴트(#FDF1F0·#FBE2E2)는 저장하지 않는다 — 강조색에서 런타임에 만든다.
ALTER TABLE bots ADD COLUMN IF NOT EXISTS accent_color TEXT;         -- 강조색. NULL 이면 #F2645C
ALTER TABLE bots ADD COLUMN IF NOT EXISTS visitor_bubble_color TEXT; -- 방문자 말풍선 배경. NULL 이면 #191d1b

COMMENT ON COLUMN bots.accent_color IS '위젯 강조색 (#rrggbb 소문자). NULL 이면 Feedloop 기본 코랄 #F2645C. 플로팅 버튼·미읽음 배지·아바타·AI 배지·보내기·링크·되돌림 카드에 쓰인다.';
COMMENT ON COLUMN bots.visitor_bubble_color IS '위젯에서 방문자 자기 말풍선 배경색 (#rrggbb 소문자). NULL 이면 잉크 #191d1b. 글자색은 명도에 따라 흰색/잉크로 자동 선택된다.';
