// Stage 3 (6/6): what the /bots list may show about a bot the viewer only approves for.
import { describe, expect, it } from 'vitest';
import { APPROVER_BOT_COLUMNS, OWNER_ONLY_FIELDS, toApproverView } from '@/lib/bot/bot-list';

describe('toApproverView', () => {
  it('keeps identity, status and the entrance timestamps; drops everything an owner configures', () => {
    const row: Record<string, unknown> = {
      id: 'bot-demo',
      service_name: 'Feedloop',
      service_url: 'https://feedloop.test',
      service_description: null,
      status: 'active',
      display_name: 'Feedloop Helper',
      widget_connected_at: '2026-10-01T00:00:00Z',
      channel_connected_at: null,
      last_active_at: null,
      created_at: '2026-09-01T00:00:00Z',
    };
    for (const f of OWNER_ONLY_FIELDS) row[f] = `secret-${f}`;

    const view = toApproverView(row);
    expect(view).toEqual({
      id: 'bot-demo',
      service_name: 'Feedloop',
      service_url: 'https://feedloop.test',
      service_description: null,
      status: 'active',
      display_name: 'Feedloop Helper',
      widget_connected_at: '2026-10-01T00:00:00Z',
      channel_connected_at: null,
      last_active_at: null,
      created_at: '2026-09-01T00:00:00Z',
    });
    for (const f of OWNER_ONLY_FIELDS) expect(view).not.toHaveProperty(f);
    expect(JSON.stringify(view)).not.toContain('secret-');
  });

  it('the column list read for approver rows names none of the owner-only fields', () => {
    const columns = APPROVER_BOT_COLUMNS.split(',').map((c) => c.trim());
    for (const f of OWNER_ONLY_FIELDS) expect(columns).not.toContain(f);
    expect(columns).toContain('id');
    expect(columns).toContain('service_name');
  });
});
