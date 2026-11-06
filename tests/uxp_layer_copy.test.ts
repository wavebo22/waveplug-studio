import { test } from "node:test";
import assert from "node:assert/strict";
import { UxpLayerTree } from "../src/ps/uxpLayers.ts";
import { buildTree, copyPlan, type RawLayer } from "../src/core/layers/tree.ts";

test("UXP Alt 拖动: 副本相对前一个副本放置、整组保留变体、选中副本并可一步撤销", async () => {
  let next = 100, undoStarts = 0, undoCommits = 0, undoRollbacks = 0;
  let unsafeAfterGroupCalls = 0, sendToBackCalls = 0, forceWrongCopy = false, forceWrongMove = false;
  let bugBeforeAdjacentGroup = false, throwBeforeAdjacentGroup = false, indexMoveCalls = 0, indexGetCalls = 0;
  let refuseIndexMoves = false, cloneDeletes = 0, groupCopyLandsOnTop = false, groupMoveAfterNoop = false, groupAfterToTop = false;
  const place = { PLACEBEFORE: "before", PLACEAFTER: "after", PLACEINSIDE: "inside" } as const;
  let doc: any;
  const selected: number[] = [];

  const setParents = (layers: any[], parent: any = null) => {
    for (const l of layers) { l.parent = parent; if (l.layers) setParents(l.layers, l); }
  };
  const container = (layer: any) => layer.parent?.layers ?? doc.layers;
  const insert = (item: any, relative: any, at: string) => {
    // Simulate a Photoshop host that mistakenly interprets "after group" as "inside it".
    // A correct WaveLayer implementation must NEVER call this ambiguous placement.
    if (at === "after" && Array.isArray(relative.layers)) {
      unsafeAfterGroupCalls++;
      at = "inside";
    }
    // Real user report: a PLACEBEFORE(next sibling group) was silently inserted
    // into that group, rather than BETWEEN two sibling groups.
    if (bugBeforeAdjacentGroup && at === "before" && Array.isArray(relative.layers)) at = "inside";
    // User test 11-06: a group placed AFTER a plain layer lands at the top of the parent.
    if (groupAfterToTop && at === "after" && item.layers && !relative.layers) {
      const top = container(relative);
      top.unshift(item);
      setParents([item], relative.parent ?? null);
      return;
    }
    const parent = at === "inside" ? relative : relative.parent;
    const list = at === "inside" ? relative.layers : container(relative);
    if (!Array.isArray(list)) throw new Error("not a group");
    const index = at === "inside" ? 0 : list.indexOf(relative) + (at === "after" ? 1 : 0);
    if (index < 0) throw new Error("bad relative");
    list.splice(index, 0, item);
    setParents([item], parent);
  };
  const attach = (l: any): any => {
    l.duplicate = async (relative?: any, placement?: string) => {
      const duplicateTree = (src: any, root: boolean): any => attach({
        id: next++, name: src.name + (root ? " 拷贝" : ""), kind: src.kind,
        contentId: src.contentId, mask: src.mask,
        layers: src.layers?.map((child: any) => duplicateTree(child, false)),
      });
      if (throwBeforeAdjacentGroup && placement === "before" && Array.isArray(relative?.layers))
        throw new Error("native group-relative duplicate refused");
      const copy = duplicateTree(l, true);
      if (forceWrongCopy) insert(copy, ai, "inside");
      // Real log (D_Group after G_Hidden): the group copy lands at the top of the root instead.
      else if (groupCopyLandsOnTop && l.layers) { doc.layers.unshift(copy); setParents([copy], null); }
      else insert(copy, relative ?? l, placement ?? "before");
      return copy;
    };
    l.move = async (relative: any, placement: string) => {
      // Real log (11-06 08:14): a group moved PLACEAFTER a plain layer stayed where it was.
      if (groupMoveAfterNoop && l.layers && placement === "after") return;
      if (throwBeforeAdjacentGroup && placement === "before" && Array.isArray(relative?.layers))
        throw new Error("native group-relative move refused");
      const list = container(l);
      const i = list.indexOf(l);
      if (i < 0) throw new Error("copy not found");
      list.splice(i, 1);
      insert(l, forceWrongMove ? ai : relative, forceWrongMove ? "inside" : placement);
    };
    l.delete = async () => { cloneDeletes++; const list = container(l); list.splice(list.indexOf(l), 1); };
    l.bringToFront = async () => {
      const list = container(l), idx = list.indexOf(l);
      if (idx < 0) throw new Error("layer no longer exists");
      list.splice(idx, 1);
      list.unshift(l);
    };
    l.sendToBack = async () => {
      sendToBackCalls++;
      const list = container(l), idx = list.indexOf(l);
      if (idx < 0) throw new Error("layer no longer exists");
      list.splice(idx, 1);
      list.push(l);
    };
    return l;
  };
  const A = attach({ id: 1, name: "标题", kind: "pixel" });
  const ai = attach({ id: 10, name: "AI填充 · 杯子", kind: "group", layers: [
    attach({ id: 11, name: "v2 · 杯子", kind: "pixel", mask: true }),
    attach({ id: 12, name: "v1 · 杯子", kind: "pixel", mask: true }),
  ] });
  const group = attach({ id: 20, name: "普通组", kind: "group", layers: [
    attach({ id: 21, name: "徽章", kind: "smartObject", contentId: "shared-psb" }),
  ] });
  doc = { id: 1, name: "demo.psd", layers: [A, ai, group], activeLayers: [A] };
  setParents(doc.layers);
  // Emulates Action Manager's bottom-up itemIndex including invisible
  // layerSectionEnd tokens. An index-based insertion at the boundary BEFORE a
  // group start can escape a group even when DOM PLACEBEFORE wrongly enters it.
  type Token = { layer: any; end: boolean; parent: any };
  const tokens = (): Token[] => {
    const out: Token[] = [];
    const walk = (ls: any[], parent: any) => {
      for (const layer of ls) {
        out.push({ layer, end: false, parent });
        if (layer.layers) {
          walk(layer.layers, layer);
          out.push({ layer, end: true, parent: layer });
        }
      }
    };
    walk(doc.layers, null);
    return out;
  };
  const itemIndex = (id: number): number | null => {
    const flat = tokens(), offset = flat.findIndex(t => !t.end && t.layer.id === id);
    return offset < 0 ? null : flat.length - offset;
  };
  const moveToAmIndex = (itemId: number, targetIndex: number): any => {
    indexMoveCalls++;
    const flat = tokens();
    // A Photoshop index requests the gap immediately BEFORE its lower neighbour.
    const token = flat.find((t, i) => flat.length - i === targetIndex - 1);
    // Index=1 is the bottom boundary when the lowest AM token is a hidden
    // sectionEnd marker. At this boundary the new layer is BELOW the whole group.
    const afterLast = targetIndex === 1 && flat[flat.length - 1]?.end;
    if (!token && !afterLast) return { _obj: "error", message: "invalid index" };
    const source = flat.find(t => !t.end && t.layer.id === itemId)?.layer;
    if (!source || (token && source === token.layer)) return { _obj: "error", message: "missing source/target" };
    const sourceList = container(source);
    const initial = sourceList.indexOf(source);
    const destination = afterLast
      ? (flat[flat.length - 1].layer.parent?.layers ?? doc.layers)
      : token!.parent?.layers ?? doc.layers;
    let at = afterLast || token!.end ? destination.length : destination.indexOf(token!.layer);
    if (initial < 0 || at < 0) return { _obj: "error", message: "invalid destination" };
    sourceList.splice(initial, 1);
    if (sourceList === destination && initial < at) at--;
    destination.splice(at, 0, source);
    setParents([source], afterLast ? flat[flat.length - 1].layer.parent : token!.parent);
    return {};
  };
  const fakePs: any = {
    app: { activeDocument: doc, documents: [doc] },
    constants: { ElementPlacement: place },
    core: { executeAsModal: async (fn: (ctx: any) => Promise<any>) => fn({
      hostControl: {
        suspendHistory: async () => { undoStarts++; return 42; },
        resumeHistory: async (_id: number, committed: boolean) => { if (committed) undoCommits++; else undoRollbacks++; },
      },
    }) },
    action: { batchPlay: async (actions: any[]) => actions.map(d => {
      if (d._obj === "get" && d._target?.[0]?._property === "itemIndex") {
        indexGetCalls++;
        const index = itemIndex(Number(d._target?.[1]?._id));
        return index === null ? { _obj: "error", message: "missing layer" } : { itemIndex: index };
      }
      if (d._obj === "move" && d.to?._index !== undefined) {
        if (refuseIndexMoves) { indexMoveCalls++; return { _obj: "error", message: "refused" }; }
        return moveToAmIndex(Number(d._target?.[0]?._id), Number(d.to._index));
      }
      if (d._obj === "select") {
        const id = Number(d._target?.[0]?._id);
        if (!d.selectionModifier) selected.length = 0;
        selected.push(id);
        const find = (ls: any[]): any => { for (const l of ls) { if (l.id === id) return l; const child = l.layers && find(l.layers); if (child) return child; } return null; };
        doc.activeLayers = selected.map(x => find(doc.layers)).filter(Boolean);
      }
      return {};
    }) },
  };
  const previous = (globalThis as any).require;
  (globalThis as any).require = (name: string) => {
    assert.equal(name, "photoshop");
    return fakePs;
  };
  try {
    const tree = new UxpLayerTree();
    // The second step refers to source 1: UXP must replace this with its newly copied ID.
    const out = await tree.copy(1, [
      { id: 1, rel: 10, place: "after" },
      { id: 20, rel: 1, place: "after" },
    ]);
    assert.equal(out.done, 2);
    assert.deepEqual(out.skipped, []);
    assert.deepEqual(selected, out.ids);
    assert.equal(undoStarts, 1);
    assert.equal(undoCommits, 1);
    assert.deepEqual(doc.layers.map((l: any) => l.id), [1, 10, out.ids[0], out.ids[1], 20]);
    assert.equal(doc.layers[3].layers.length, 1);
    assert.equal(doc.layers[3].layers[0].contentId, "shared-psb"); // not Make Unique
    assert.equal(group.layers[0].contentId, "shared-psb");
    assert.equal(group.layers.length, 1);

    const aiCopy = await tree.copy(1, [{ id: 10, rel: 10, place: "after" }]);
    assert.equal(aiCopy.done, 1);
    const newAi = doc.layers.find((l: any) => l.id === aiCopy.ids[0]);
    assert.ok(newAi?.name.startsWith("AI填充"));
    assert.deepEqual(newAi.layers.map((l: any) => l.name), ["v2 · 杯子", "v1 · 杯子"]);
    assert.ok(newAi.layers.every((l: any) => l.mask)); // original masks copied
    assert.equal(ai.layers.length, 2);
    assert.deepEqual(selected, aiCopy.ids);
    assert.equal(undoStarts, 2);
    assert.equal(undoCommits, 2);

    // Photoshop UXP only accepts a group as an INSIDE destination, and the pure plan prevents
    // nesting a copy of an AI group inside itself or into its hidden variant children.
    const raw = [
      { id: 10, name: ai.name, kind: 7, section: "start", visible: true, locked: false, mask: false },
      { id: 11, name: "v2", kind: 1, section: "content", visible: true, locked: false, mask: false },
      { id: 12, name: "v1", kind: 1, section: "content", visible: false, locked: false, mask: false },
      { id: 0, name: "", kind: 13, section: "end", visible: true, locked: false, mask: false },
    ] as RawLayer[];
    assert.equal(copyPlan(buildTree(raw), [10], 10, "inside"), null);

    // Even if Photoshop misinterprets "after group", move/clone must use a
    // BEFORE-next-sibling anchor and remain at the outer document level.
    doc.layers = [A, ai, group];
    setParents(doc.layers);
    bugBeforeAdjacentGroup = true;
    const moveCallsBefore = indexMoveCalls, readCallsBefore = indexGetCalls;
    const movedBelow = await tree.move(1, [{ id: 1, rel: 10, place: "after" }]);
    bugBeforeAdjacentGroup = false;
    assert.equal(movedBelow.done, 1);
    assert.ok(indexMoveCalls > moveCallsBefore, "AM index recovery was not attempted");
    assert.ok(indexMoveCalls - moveCallsBefore <= 2, "Common AI boundary must not brute-force five AM moves");
    assert.equal(indexGetCalls - readCallsBefore, 1, "Common AI boundary needs just one index read");
    assert.deepEqual(doc.layers.map((l: any) => l.id), [10, 1, 20]);
    assert.deepEqual(ai.layers.map((l: any) => l.id), [11, 12]);
    assert.equal(unsafeAfterGroupCalls, 0);

    // Duplicating at the same boundary must also correct the host's nesting error.
    doc.layers = [A, ai, group];
    setParents(doc.layers);
    bugBeforeAdjacentGroup = true;
    const copyCallsBefore = indexMoveCalls, copyReadsBefore = indexGetCalls;
    const wrongAnchorCopy = await tree.copy(1, [{ id: 1, rel: 10, place: "after" }]);
    bugBeforeAdjacentGroup = false;
    assert.equal(wrongAnchorCopy.done, 1);
    assert.equal(indexMoveCalls - copyCallsBefore, 1, "Learned boundary offset should place the copy in one AM move");
    assert.equal(indexGetCalls - copyReadsBefore, 1, "Learned boundary offset should use one AM get");
    assert.deepEqual(doc.layers.map((l: any) => l.id), [1, 10, wrongAnchorCopy.ids[0], 20]);
    assert.deepEqual(ai.layers.map((l: any) => l.id), [11, 12]);

    // Some Photoshop builds THROW instead of nesting into the adjacent group.
    // Move and duplicate must both recover via AM indices rather than giving an error.
    doc.layers = [A, ai, group];
    setParents(doc.layers);
    throwBeforeAdjacentGroup = true;
    const thrownMove = await tree.move(1, [{ id: 1, rel: 10, place: "after" }]);
    assert.equal(thrownMove.done, 1);
    assert.deepEqual(doc.layers.map((l: any) => l.id), [10, 1, 20]);
    doc.layers = [A, ai, group];
    setParents(doc.layers);
    const thrownCopy = await tree.copy(1, [{ id: 1, rel: 10, place: "after" }]);
    throwBeforeAdjacentGroup = false;
    assert.equal(thrownCopy.done, 1);
    assert.deepEqual(doc.layers.map((l: any) => l.id), [1, 10, thrownCopy.ids[0], 20]);

    // A group with NO next sibling is the most dangerous case: make a copy above
    // the group, then send it to the bottom at the SAME parent level.
    doc.layers = [A, ai];
    setParents(doc.layers);
    const bottomCopy = await tree.copy(1, [{ id: 1, rel: 10, place: "after" }]);
    assert.equal(bottomCopy.done, 1);
    assert.deepEqual(doc.layers.map((l: any) => l.id), [1, 10, bottomCopy.ids[0]]);
    assert.deepEqual(ai.layers.map((l: any) => l.id), [11, 12]);
    assert.ok(sendToBackCalls > 0);
    assert.equal(unsafeAfterGroupCalls, 0);

    // Copying the AI group itself at the bottom must keep all variants together,
    // and put its duplicate at the same parent level.
    doc.layers = [A, ai];
    setParents(doc.layers);
    const lastAiCopy = await tree.copy(1, [{ id: 10, rel: 10, place: "after" }]);
    assert.equal(lastAiCopy.done, 1);
    assert.equal(doc.layers[doc.layers.length - 1].id, lastAiCopy.ids[0]);
    assert.deepEqual(doc.layers[doc.layers.length - 1].layers.map((l: any) => l.name),
      ["v2 · 杯子", "v1 · 杯子"]);
    assert.equal(unsafeAfterGroupCalls, 0);

    // Normal move is protected by the very same parent-safe placement path.
    doc.layers = [A, ai];
    setParents(doc.layers);
    const bottomMove = await tree.move(1, [{ id: 1, rel: 10, place: "after" }]);
    assert.equal(bottomMove.done, 1);
    assert.deepEqual(doc.layers.map((l: any) => l.id), [10, 1]);
    assert.deepEqual(ai.layers.map((l: any) => l.id), [11, 12]);
    assert.equal(unsafeAfterGroupCalls, 0);

    // A nested AI group at the bottom of a normal folder: copy must stay inside
    // the normal folder but OUTSIDE the AI group.
    group.layers = [ai];
    doc.layers = [A, group];
    setParents(doc.layers);
    const nestedCopy = await tree.copy(1, [{ id: 1, rel: 10, place: "after" }]);
    assert.equal(nestedCopy.done, 1);
    assert.deepEqual(group.layers.map((l: any) => l.id), [10, nestedCopy.ids[0]]);
    assert.deepEqual(ai.layers.map((l: any) => l.id), [11, 12]);
    assert.equal(unsafeAfterGroupCalls, 0);

    // Even if Photoshop initially ignores the safe anchor, the operation must
    // recover and finish at the requested position WITHOUT showing an error.
    const childrenBefore = ai.layers.map((l: any) => l.id);
    forceWrongCopy = true;
    const recoveredCopy = await tree.copy(1, [{ id: 1, rel: 10, place: "after" }]);
    forceWrongCopy = false;
    assert.equal(recoveredCopy.done, 1);
    assert.deepEqual(recoveredCopy.skipped, []);
    assert.deepEqual(group.layers.slice(0, 2).map((l: any) => l.id), [10, recoveredCopy.ids[0]]);
    assert.equal(group.layers[2].id, nestedCopy.ids[0]);
    assert.deepEqual(ai.layers.map((l: any) => l.id), childrenBefore);
    assert.equal(unsafeAfterGroupCalls, 0);

    doc.layers = [A, ai];
    setParents(doc.layers);
    forceWrongMove = true;
    const repairedMove = await tree.move(1, [{ id: 1, rel: 10, place: "after" }]);
    forceWrongMove = false;
    assert.equal(repairedMove.done, 1);
    assert.deepEqual(repairedMove.skipped, []);
    assert.deepEqual(doc.layers.map((l: any) => l.id), [10, 1]);
    assert.equal(undoRollbacks, 0);

    // A group copy placed above a plain target layer, with every AM index move refused: the DOM
    // move beside the plain layer puts it right, without an error or a rollback.
    doc.layers = [ai, A, group];
    setParents(doc.layers);
    const rollbacksBeforeTop = undoRollbacks;
    groupCopyLandsOnTop = true; refuseIndexMoves = true;
    const topCopy = await tree.copy(1, [{ id: 20, rel: 1, place: "after" }]);
    groupCopyLandsOnTop = false; refuseIndexMoves = false;
    assert.equal(topCopy.done, 1);
    assert.deepEqual(topCopy.skipped, []);
    assert.deepEqual(doc.layers.map((l: any) => l.id), [10, 1, topCopy.ids[0], 20]);
    assert.equal(doc.layers[2].layers.length, group.layers.length);
    assert.equal(undoRollbacks, rollbacksBeforeTop);

    // The group directly above a plain layer refuses to move below it (real log 08:14, move and
    // Alt copy alike): the plain layer is moved above the group instead, never into it.
    doc.layers = [group, A, ai];
    setParents(doc.layers);
    groupMoveAfterNoop = true; refuseIndexMoves = true;
    const swapMove = await tree.move(1, [{ id: 20, rel: 1, place: "after" }]);
    assert.equal(swapMove.done, 1);
    assert.deepEqual(swapMove.skipped, []);
    assert.deepEqual(doc.layers.map((l: any) => l.id), [1, 20, 10]);
    doc.layers = [A, group, ai];
    setParents(doc.layers);
    groupCopyLandsOnTop = true;
    const swapCopy = await tree.copy(1, [{ id: 20, rel: 1, place: "after" }]);
    groupCopyLandsOnTop = false; groupMoveAfterNoop = false; refuseIndexMoves = false;
    assert.equal(swapCopy.done, 1);
    assert.deepEqual(doc.layers.map((l: any) => l.id), [1, swapCopy.ids[0], 20, 10]);
    assert.equal(doc.layers[1].layers.length, group.layers.length);
    assert.equal(undoRollbacks, rollbacksBeforeTop);

    // Dropped on the lower half of a plain row (after it), adjacent or not: only PLACEBEFORE on
    // the next sibling is used, so the group never jumps to the top.
    const B = attach({ id: 2, name: "正文", kind: "pixel" });
    doc.layers = [group, A, B, ai];
    setParents(doc.layers);
    groupAfterToTop = true; refuseIndexMoves = true;
    const belowB = await tree.move(1, [{ id: 20, rel: 2, place: "after" }]);
    assert.equal(belowB.done, 1);
    assert.deepEqual(doc.layers.map((l: any) => l.id), [1, 2, 20, 10]);
    const copyBelowA = await tree.copy(1, [{ id: 20, rel: 1, place: "after" }]);
    groupAfterToTop = false; refuseIndexMoves = false;
    assert.equal(copyBelowA.done, 1);
    assert.deepEqual(doc.layers.map((l: any) => l.id), [1, copyBelowA.ids[0], 2, 20, 10]);
    assert.equal(undoRollbacks, rollbacksBeforeTop);

    // Placement that cannot be repaired: the whole history step is rejected (Photoshop rolls back
    // every clone and anything the index probing scattered), never a clone.delete that could
    // leave a group's children behind as stray root layers.
    const rollbacksBefore = undoRollbacks, deletesBefore = cloneDeletes;
    forceWrongCopy = true; refuseIndexMoves = true;
    await assert.rejects(tree.copy(1, [{ id: 1, rel: 10, place: "after" }]), /已撤销本次复制/);
    forceWrongCopy = false; refuseIndexMoves = false;
    assert.equal(undoRollbacks, rollbacksBefore + 1);
    assert.equal(cloneDeletes, deletesBefore);

    // Document switch protection: copies must not be written into a different PSD.
    const beforeSwitch = undoStarts;
    fakePs.app.activeDocument = { id: 2 };
    await assert.rejects(tree.copy(1, [{ id: 1, rel: 10, place: "after" }]), /文档已切换/);
    assert.equal(undoStarts, beforeSwitch);
  } finally {
    (globalThis as any).require = previous;
  }
});
