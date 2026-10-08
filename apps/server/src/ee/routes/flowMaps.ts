import {
  addFlowMapNodeSchema,
  createFlowMapEdgeSchema,
  createFlowMapSchema,
  type FlowMap,
  type FlowMapsResponse,
  saveFlowMapLayoutSchema,
  updateFlowMapEdgeSchema,
  updateFlowMapSchema,
} from "@bullpane/shared";
import type { FastifyInstance } from "fastify";
import { requireAuth, requireRole } from "../../auth/guards";
import { requireFeature } from "../../plugins/gates";

type IdParams = { Params: { id: string } };
type NodeParams = { Params: { id: string; nodeId: string } };
type EdgeParams = { Params: { id: string; edgeId: string } };

/** POST /flow-maps/:id/copy body `{ name?, parentId? }`: the create schema with the name optional. */
const copyFlowMapSchema = createFlowMapSchema.omit({ description: true }).partial({ name: true });

/** docs/API.md "Flow maps". Not audited (see ee/plugins/audit.ts): a map is a drawing. */
export async function flowMapRoutes(app: FastifyInstance): Promise<void> {
  // Auth first (401), then the pro gate (402), then the role (403) — see docs/API.md.
  const gate = requireFeature("flows");
  const viewer = [requireAuth, gate, requireRole("viewer")];
  const operator = [requireAuth, gate, requireRole("operator")];

  app.get("/flow-maps", { preHandler: viewer }, async (): Promise<FlowMapsResponse> => app.ctx.flowMaps.list());

  app.post("/flow-maps", { preHandler: operator }, async (request, reply): Promise<FlowMap> => {
    const map = await app.ctx.flowMaps.create(createFlowMapSchema.parse(request.body));
    reply.status(201);
    return map;
  });

  app.get<IdParams>("/flow-maps/:id", { preHandler: viewer }, async (request): Promise<FlowMap> => app.ctx.flowMaps.get(request.params.id));

  app.patch<IdParams>("/flow-maps/:id", { preHandler: operator }, async (request): Promise<FlowMap> =>
    app.ctx.flowMaps.update(request.params.id, updateFlowMapSchema.parse(request.body ?? {})),
  );

  app.delete<IdParams>("/flow-maps/:id", { preHandler: operator }, async (request) => {
    await app.ctx.flowMaps.remove(request.params.id);
    return { ok: true };
  });

  app.post<IdParams>("/flow-maps/:id/nodes", { preHandler: operator }, async (request): Promise<FlowMap> =>
    app.ctx.flowMaps.addNode(request.params.id, addFlowMapNodeSchema.parse(request.body)),
  );

  app.delete<NodeParams>("/flow-maps/:id/nodes/:nodeId", { preHandler: operator }, async (request): Promise<FlowMap> =>
    app.ctx.flowMaps.removeNode(request.params.id, request.params.nodeId),
  );

  app.put<IdParams>("/flow-maps/:id/layout", { preHandler: operator }, async (request) => {
    await app.ctx.flowMaps.saveLayout(request.params.id, saveFlowMapLayoutSchema.parse(request.body));
    return { ok: true };
  });

  app.post<IdParams>("/flow-maps/:id/edges", { preHandler: operator }, async (request, reply): Promise<FlowMap> => {
    const map = await app.ctx.flowMaps.addEdge(request.params.id, createFlowMapEdgeSchema.parse(request.body));
    reply.status(201);
    return map;
  });

  app.patch<EdgeParams>("/flow-maps/:id/edges/:edgeId", { preHandler: operator }, async (request): Promise<FlowMap> =>
    app.ctx.flowMaps.updateEdge(request.params.id, request.params.edgeId, updateFlowMapEdgeSchema.parse(request.body)),
  );

  app.delete<EdgeParams>("/flow-maps/:id/edges/:edgeId", { preHandler: operator }, async (request): Promise<FlowMap> =>
    app.ctx.flowMaps.removeEdge(request.params.id, request.params.edgeId),
  );

  app.post<IdParams>("/flow-maps/:id/copy", { preHandler: operator }, async (request, reply): Promise<FlowMap> => {
    const map = await app.ctx.flowMaps.copy(request.params.id, copyFlowMapSchema.parse(request.body ?? {}));
    reply.status(201);
    return map;
  });
}
