import { studioAgentEnabled } from '@/lib/studio/llm-config';
import { RefundStudioPage } from '@/components/studio/RefundStudioPage';

// Refund Studio — AG Studio over the sample store. Server part only decides two things the browser must not:
// whether the agent is on (an LLM key exists on the server) and the AG Studio licence key (set in Vercel, never committed).
export default function Page() {
  return <RefundStudioPage licenseKey={process.env.AG_STUDIO_LICENSE_KEY || undefined} aiEnabled={studioAgentEnabled()} />;
}
