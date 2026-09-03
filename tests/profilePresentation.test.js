import assert from "node:assert/strict";
import test from "node:test";
import { orderedProfileNames, profileDisplayMeta } from "../src/profilePresentation.js";

test("known profiles keep office order and newly discovered members remain available", () => {
  const result = orderedProfileNames([
    { name: "team-zeta" },
    { name: "hermes-operations" },
    { name: "team-alpha" },
    { name: "invalid/profile" },
  ], ["default", "hermes-operations"]);
  assert.deepEqual(result, ["hermes-operations", "team-alpha", "team-zeta"]);
});

test("new member presentation is deterministic without impersonating the default profile", () => {
  const profiles = [{ name: "team-hayun", display_name: "하윤", role: "리서치", color: "#123456" }];
  assert.deepEqual(profileDisplayMeta("team-hayun", profiles, { default: { name: "민준" } }), {
    name: "하윤",
    role: "리서치",
    initials: "하윤",
    color: "#123456",
    avatar: "",
  });
  assert.equal(profileDisplayMeta("team-new-member", [], {}).name, "Member");
});
