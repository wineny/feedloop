// "Try the demo bot" — adds the signed-in user as an approver of the demo bot (bots.is_demo).
//
// Why a membership instead of a shared login: judges each sign in with their own Google account,
// so nobody shares a password and nothing one judge does shows up under another's name. The bot
// itself keeps a single owner; approvers only get the operator screens (lib/auth/ownership.ts).
//
// Idempotent: pressing the button twice is a no-op. Every success answers the same shape,
// { botId, role, alreadyMember }, so the client can tell a repeat press from a first join.

import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { getServiceRoleClient } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

export async function POST() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = getServiceRoleClient();
  const { data: demo, error } = await db
    .from('bots')
    .select('id, user_id, service_name')
    .eq('is_demo', true)
    .maybeSingle();

  if (error) {
    console.error('[demo/join] lookup failed:', error.message);
    return NextResponse.json({ error: 'Demo bot lookup failed' }, { status: 500 });
  }
  if (!demo) {
    // Fresh self-hosted install without `scripts/seed-demo.ts` having run.
    return NextResponse.json({ error: 'No demo bot on this deployment yet' }, { status: 404 });
  }

  if (demo.user_id === session.user.id) {
    return NextResponse.json({ botId: demo.id, role: 'owner', alreadyMember: true });
  }

  const { data: existing, error: lookupError } = await db
    .from('bot_members')
    .select('bot_id')
    .eq('bot_id', demo.id)
    .eq('user_id', session.user.id)
    .maybeSingle();

  if (lookupError) {
    console.error('[demo/join] membership lookup failed:', lookupError.message);
    return NextResponse.json({ error: 'Could not join the demo bot' }, { status: 500 });
  }
  if (existing) {
    return NextResponse.json({ botId: demo.id, role: 'approver', alreadyMember: true });
  }

  const { error: insertError } = await db
    .from('bot_members')
    .upsert({ bot_id: demo.id, user_id: session.user.id, role: 'approver' }, { onConflict: 'bot_id,user_id', ignoreDuplicates: true });

  if (insertError) {
    console.error('[demo/join] insert failed:', insertError.message);
    return NextResponse.json({ error: 'Could not join the demo bot' }, { status: 500 });
  }

  return NextResponse.json({ botId: demo.id, role: 'approver', alreadyMember: false });
}
