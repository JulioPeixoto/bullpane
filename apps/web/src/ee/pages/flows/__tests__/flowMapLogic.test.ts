import { describe, expect, it } from "vitest";
import type { FlowMapSummary } from "@bullpane/shared";
import { CONNECTION_COLORS, ancestorsOf, connectionColor, buildMapTree, flattenTree, groupDetected, mapConnections, moveTargets, parseNodeId, placeUnplaced } from "../flowMapLogic";

const map = (id: string, patch: Partial<FlowMapSummary> = {}): FlowMapSummary => ({
  id,
  kind: "manual",
  name: id,
  description: null,
  parentId: null,
  position: 0,
  connectionId: null,
  nodeCount: 0,
  edgeCount: 0,
  ...patch,
});

const W = 220;
const H = 84;
const opts = { nodeWidth: W, nodeHeight: H, columnGap: 90, rowGap: 28 };

describe("buildMapTree", () => {
  it("nests by parentId and orders siblings by position, then name", () => {
    const tree = buildMapTree([
      map("b", { position: 1 }),
      map("a", { position: 0 }),
      map("a2", { parentId: "a", position: 1 }),
      map("a1", { parentId: "a", position: 0 }),
      map("d", { kind: "detected", connectionId: "c1" }),
    ]);
    expect(tree.map((n) => n.map.id)).toEqual(["a", "b"]);
    expect(tree[0].children.map((n) => [n.map.id, n.depth])).toEqual([
      ["a1", 1],
      ["a2", 1],
    ]);
  });

  it("keeps maps whose parent is gone, at the root", () => {
    const tree = buildMapTree([map("orphan", { parentId: "deleted" })]);
    expect(tree.map((n) => n.map.id)).toEqual(["orphan"]);
  });

  it("terminates on a parent cycle and still shows every map once", () => {
    const tree = buildMapTree([map("x", { parentId: "y" }), map("y", { parentId: "x" })]);
    const flat = flattenTree(tree);
    expect(flat.map((n) => n.map.id).sort()).toEqual(["x", "y"]);
  });

  it("flattenTree skips the children of collapsed maps", () => {
    const tree = buildMapTree([map("a"), map("a1", { parentId: "a" }), map("b", { position: 1 })]);
    expect(flattenTree(tree).map((n) => n.map.id)).toEqual(["a", "a1", "b"]);
    expect(flattenTree(tree, new Set(["a"])).map((n) => n.map.id)).toEqual(["a", "b"]);
  });
});

describe("moveTargets", () => {
  const maps = [
    map("a"),
    map("a1", { parentId: "a" }),
    map("a1x", { parentId: "a1" }),
    map("b", { position: 1 }),
    map("d", { kind: "detected", connectionId: "c1" }),
  ];

  it("never offers the map itself or any of its descendants", () => {
    const ids = moveTargets(maps, "a").map((t) => t.id);
    expect(ids).toEqual([null, "b"]);
  });

  it("offers the top level, ancestors and unrelated maps, indented", () => {
    expect(moveTargets(maps, "a1x").map((t) => [t.id, t.depth])).toEqual([
      [null, 0],
      ["a", 1],
      ["a1", 2],
      ["b", 1],
    ]);
  });

  it("never offers detected maps", () => {
    expect(moveTargets(maps, "b").some((t) => t.id === "d")).toBe(false);
  });
});

describe("ancestorsOf", () => {
  it("returns the chain root first and stops on cycles", () => {
    const maps = [map("a"), map("a1", { parentId: "a" }), map("a1x", { parentId: "a1" })];
    expect(ancestorsOf(maps, "a1x").map((m) => m.id)).toEqual(["a", "a1"]);
    expect(ancestorsOf([map("x", { parentId: "y" }), map("y", { parentId: "x" })], "x").map((m) => m.id)).toEqual(["y"]);
  });
});

describe("groupDetected", () => {
  it("groups by connection in connection order", () => {
    const groups = groupDetected(
      [
        map("detected:c2:z", { kind: "detected", connectionId: "c2", name: "z" }),
        map("detected:c1:b", { kind: "detected", connectionId: "c1", name: "b" }),
        map("detected:c1:a", { kind: "detected", connectionId: "c1", name: "a" }),
        map("manual"),
      ],
      ["c1", "c2"],
    );
    expect(groups.map((g) => [g.connectionId, g.maps.map((m) => m.name)])).toEqual([
      ["c1", ["a", "b"]],
      ["c2", ["z"]],
    ]);
  });
});

describe("placeUnplaced", () => {
  it("lays out everything left to right when nothing is placed", () => {
    const pos = placeUnplaced(
      [
        { id: "a", x: null, y: null },
        { id: "b", x: null, y: null },
      ],
      [{ from: "a", to: "b" }],
      opts,
    );
    expect(pos.get("a")!.x).toBeLessThan(pos.get("b")!.x);
  });

  it("returns nothing when every node is placed", () => {
    expect(placeUnplaced([{ id: "a", x: 0, y: 0 }], [], opts).size).toBe(0);
  });

  it("puts a new successor one column right of its placed predecessor, without moving anyone", () => {
    const pos = placeUnplaced(
      [
        { id: "a", x: 100, y: 50 },
        { id: "b", x: null, y: null },
      ],
      [{ from: "a", to: "b" }],
      opts,
    );
    expect([...pos.keys()]).toEqual(["b"]);
    expect(pos.get("b")).toEqual({ x: 100 + W + 90, y: 50 });
  });

  it("puts a new predecessor one column left of its placed successor", () => {
    const pos = placeUnplaced(
      [
        { id: "a", x: null, y: null },
        { id: "b", x: 500, y: 0 },
      ],
      [{ from: "a", to: "b" }],
      opts,
    );
    expect(pos.get("a")).toEqual({ x: 500 - W - 90, y: 0 });
  });

  it("slides a node down when its spot is taken", () => {
    const pos = placeUnplaced(
      [
        { id: "a", x: 0, y: 0 },
        { id: "b", x: W + 90, y: 0 },
        { id: "c", x: null, y: null },
      ],
      [
        { from: "a", to: "b" },
        { from: "a", to: "c" },
      ],
      opts,
    );
    expect(pos.get("c")).toEqual({ x: W + 90, y: H + 28 });
  });

  it("grows a new chain link by link from a placed node", () => {
    const pos = placeUnplaced(
      [
        { id: "a", x: 0, y: 0 },
        { id: "b", x: null, y: null },
        { id: "c", x: null, y: null },
      ],
      [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
      ],
      opts,
    );
    expect(pos.get("b")).toEqual({ x: W + 90, y: 0 });
    expect(pos.get("c")).toEqual({ x: 2 * (W + 90), y: 0 });
  });

  it("parks unconnected new queues under the drawing, never on top of it", () => {
    const nodes = [
      { id: "a", x: 0, y: 0 },
      { id: "b", x: W + 90, y: 0 },
      { id: "lonely", x: null, y: null },
    ];
    const pos = placeUnplaced(nodes, [{ from: "a", to: "b" }], opts);
    const p = pos.get("lonely")!;
    expect(p.y).toBeGreaterThanOrEqual(H);
    expect(p.x).toBe(0);
  });
});

describe("mapConnections", () => {
  const order = [
    { id: "events", name: "events" },
    { id: "ai", name: "ai" },
    { id: "voice", name: "voice" },
  ];

  it("lists the connections a map spans in connection order, with queue counts", () => {
    const conns = mapConnections([{ connectionId: "ai" }, { connectionId: "events" }, { connectionId: "ai" }], order);
    expect(conns.map((c) => [c.connectionId, c.name, c.count])).toEqual([
      ["events", "events", 1],
      ["ai", "ai", 2],
    ]);
  });

  it("colours follow the installation's connection list, not the map", () => {
    const onlyAi = mapConnections([{ connectionId: "ai" }], order);
    const both = mapConnections([{ connectionId: "ai" }, { connectionId: "events" }], order);
    // adding an "events" queue must not repaint "ai"
    expect(onlyAi[0].color).toBe(CONNECTION_COLORS[1]);
    expect(both.find((c) => c.connectionId === "ai")!.color).toBe(CONNECTION_COLORS[1]);
    expect(both.find((c) => c.connectionId === "events")!.color).toBe(CONNECTION_COLORS[0]);
  });

  it("is the same whatever order the nodes were added in", () => {
    const a = mapConnections([{ connectionId: "voice" }, { connectionId: "events" }], order);
    const b = mapConnections([{ connectionId: "events" }, { connectionId: "voice" }], order);
    expect(a).toEqual(b);
  });

  it("the same queue name on two connections counts on both", () => {
    const conns = mapConnections([{ connectionId: "events" }, { connectionId: "ai" }]);
    expect(conns.map((c) => c.connectionId)).toEqual(["ai", "events"]);
    expect(conns.every((c) => c.count === 1)).toBe(true);
  });

  it("gives an unknown connection a stable colour", () => {
    expect(connectionColor("gone", order)).toBe(connectionColor("gone", order));
    expect(CONNECTION_COLORS).toContain(connectionColor("gone", []));
  });
});

describe("parseNodeId", () => {
  it("splits on the first colon only (queue names may contain colons)", () => {
    expect(parseNodeId("events:order-placed")).toEqual({ connectionId: "events", queueName: "order-placed" });
    expect(parseNodeId("ai:a:b")).toEqual({ connectionId: "ai", queueName: "a:b" });
    expect(parseNodeId("nocolon")).toBeNull();
  });
});
