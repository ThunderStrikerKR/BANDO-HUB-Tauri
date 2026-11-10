import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { tsImport } from "tsx/esm/api";

const read = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const source = {
  hub: read("src/HubWorkspace.tsx"),
  brand: read("src/Classification.tsx"),
  alias: read("src/AliasManager.tsx"),
  freight: read("src/ActualFreightField.tsx"),
  queue: read("src/WorkflowQueue.tsx"),
  color: read("src/ColorGuidanceManager.tsx"),
  shipping: read("src/ShippingManager.tsx"),
};

test("unrelated workflow saves preserve another order's unsaved draft", async () => {
  const { retainUnsavedOrderEdits } = await tsImport("../src/order-edit-snapshots.ts", import.meta.url);
  const persisted = [{ id:"order-a", raw:"saved A" }, { id:"order-b", raw:"saved B" }];
  const edits = { "order-a": { id:"order-a", raw:"draft A" } };
  assert.deepEqual(retainUnsavedOrderEdits(edits, persisted), edits);
  assert.deepEqual(retainUnsavedOrderEdits(edits, [persisted[0], { id:"order-b",raw:"changed B" }]), edits);
  assert.deepEqual(retainUnsavedOrderEdits(edits, [{ id:"order-a",raw:"draft A" }, persisted[1]]), {});
  assert.deepEqual(retainUnsavedOrderEdits(edits, [persisted[1]]), edits);
  assert.deepEqual(retainUnsavedOrderEdits({ ...edits, "order-b": { id:"order-b", raw:"draft B" } }, [
    { id:"order-a", raw:"draft A" }, persisted[1],
  ]), { "order-b": { id:"order-b", raw:"draft B" } });
  assert.match(source.hub, /retainUnsavedOrderEdits\(previous, next\.orders\)/);
});

test("brand and alias changes guard item-to-item switching", () => {
  assert.match(source.brand, /const chooseBrand = async/);
  assert.match(source.brand, /if \(dirty\) \{[\s\S]*?requestPageLeave/);
  assert.match(source.brand, /onClick=\{\(\) => void chooseBrand\(b\)\}/);
  assert.match(source.alias, /const chooseAlias = async/);
  assert.match(source.alias, /onClick=\{\(\) => void chooseAlias\(a\)\}/);
});

test("actual freight edits survive filtering and are guarded on navigation", () => {
  assert.match(source.freight, /usePageLeaveGuard\(/);
  assert.match(source.freight, /current === previousSaved\.current \? saved : current/);
  assert.match(source.queue, /const \[freightDrafts, setFreightDrafts\]/);
  assert.match(source.queue, /onDraftChange=\{\(value\) => setFreightDrafts/);
  assert.match(source.queue, /saveFreightDrafts/);
  assert.match(source.queue, /requestPageLeave/);
  assert.match(source.hub, /const fields = await requestPageLeave/);
});

test("uncommitted color and freight group names never vanish or auto-create", () => {
  assert.match(source.color, /hasChanges: \(\) => unsaved \|\| name\.length > 0/);
  assert.match(source.color, /if \(name\.length > 0\)/);
  assert.match(source.color, /setName\(""\)/);
  assert.match(source.shipping, /hasChanges: \(\) => changes\.length > 0 \|\| editingDirty \|\| newName\.length > 0/);
  assert.match(source.shipping, /if \(newName\.length > 0\)/);
  assert.match(source.shipping, /setNewName\(""\)/);
});
