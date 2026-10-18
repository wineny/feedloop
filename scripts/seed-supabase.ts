import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import path from 'path';

// Load environment variables from .env.local
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('Missing Supabase URL or Service Role Key in .env.local');
  process.exit(1);
}

// Create a Supabase client with the service role key to bypass RLS
const supabase = createClient(supabaseUrl, supabaseServiceKey);

async function seedData() {
  console.log('🌱 Starting Supabase data seeding...');

  try {
    // 1. Create a dummy user
    console.log('Creating dummy user...');
    const { data: user, error: userError } = await supabase
      .from('users')
      .insert({
        name: 'Test User',
        email: `test-${Date.now()}@example.com`,
        image: 'https://avatars.githubusercontent.com/u/9919?v=4',
        email_verified: new Date().toISOString(),
      })
      .select()
      .single();

    if (userError) throw userError;
    console.log(`✅ User created: ${user.name} (${user.id})`);

    // 2. Create dummy bots for the user
    console.log('Creating dummy bots...');
    const botsToInsert = [
      {
        user_id: user.id,
        bot_token_encrypted: 'dummy_encrypted_token_1',
        bot_username: '@rona_test_bot',
        service_name: '로나',
        service_description: '인터뷰 봇 로나입니다.',
        status: 'active',
        llm_provider: 'gemini',
      },
      {
        user_id: user.id,
        bot_token_encrypted: 'dummy_encrypted_token_2',
        bot_username: '@kokjibi_test_bot',
        service_name: '콕집이',
        service_description: '콕 찝어주는 콕집이입니다.',
        status: 'active',
        llm_provider: 'anthropic',
      }
    ];

    const { data: bots, error: botsError } = await supabase
      .from('bots')
      .insert(botsToInsert)
      .select();

    if (botsError) throw botsError;
    console.log(`✅ Created ${bots.length} bots`);

    const ronaBot = bots[0];

    // 3. Create dummy messages
    console.log('Creating dummy messages...');
    const messagesToInsert = [
      {
        bot_id: ronaBot.id,
        telegram_message_id: 1001,
        chat_id: -100123456789,
        author_name: 'Alice',
        author_id: 11111,
        body: '이 기능 너무 불편해요. 버튼이 잘 안 보입니다.',
        detected_at: new Date(Date.now() - 1000 * 60 * 60 * 2).toISOString(), // 2 hours ago
      },
      {
        bot_id: ronaBot.id,
        telegram_message_id: 1002,
        chat_id: -100123456789,
        author_name: 'Bob',
        author_id: 22222,
        body: '다크모드 지원 언제 되나요?',
        detected_at: new Date(Date.now() - 1000 * 60 * 60).toISOString(), // 1 hour ago
      },
      {
        bot_id: ronaBot.id,
        telegram_message_id: 1003,
        chat_id: -100123456789,
        author_name: 'Charlie',
        author_id: 33333,
        body: '결제 중에 자꾸 에러가 납니다 확인해주세요',
        detected_at: new Date().toISOString(), // now
      }
    ];

    const { data: messages, error: msgsError } = await supabase
      .from('messages')
      .insert(messagesToInsert)
      .select();

    if (msgsError) throw msgsError;
    console.log(`✅ Created ${messages.length} messages`);

    // 4. Create dummy insights
    console.log('Creating dummy insights...');
    const insightsToInsert = [
      {
        bot_id: ronaBot.id,
        message_id: messages[0].id,
        category: 'ux',
        summary: '버튼 시인성 문제 제기',
        sentiment: 'negative',
        follow_up_needed: true,
      },
      {
        bot_id: ronaBot.id,
        message_id: messages[1].id,
        category: 'feature_request',
        summary: '다크모드 기능 요청',
        sentiment: 'neutral',
        follow_up_needed: false,
      },
      {
        bot_id: ronaBot.id,
        message_id: messages[2].id,
        category: 'bug',
        summary: '결제 중 에러 발생',
        sentiment: 'negative',
        follow_up_needed: true,
      }
    ];

    const { data: insights, error: insightsError } = await supabase
      .from('insights')
      .insert(insightsToInsert)
      .select();

    if (insightsError) throw insightsError;
    console.log(`✅ Created ${insights.length} insights`);

    console.log('🎉 Seeding completed successfully!');
  } catch (error) {
    console.error('❌ Error during seeding:', error);
  }
}

seedData();
