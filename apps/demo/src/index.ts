/**
 * demo.bullpane.com: every visitor shares one container, so they all see the
 * same live queues. The container is the free edition with BULLPANE_READ_ONLY,
 * which refuses writes on the server; refusing them here as well means a
 * scripted flood of POSTs never even reaches it.
 */
import { Container, getContainer } from "@cloudflare/containers";

export class BullpaneDemo extends Container {
  defaultPort = 3000;
  // Short: an idle container is billed by the second. A cold start costs a
  // visitor a few seconds and a fresh Redis the simulator fills in ~30 s.
  sleepAfter = "10m";
}

interface Env {
  DEMO: DurableObjectNamespace<BullpaneDemo>;
}

const READS = new Set(["GET", "HEAD"]);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!READS.has(request.method)) {
      return Response.json(
        { error: "read_only", message: "This is a read-only public demo. Install Bullpane to try every action." },
        { status: 423 },
      );
    }
    const response = await getContainer(env.DEMO, "demo").fetch(request);
    const headers = new Headers(response.headers);
    // The demo is a playground, not content: keep it out of search results.
    headers.set("X-Robots-Tag", "noindex");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
};
