import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeClub,
  externalPlatforms,
  safeHttp,
  visibleContactUrl,
  appendComments,
  requestJson,
} from "../club-detail-react/src/model.mjs";

test("API-hidden contact remains hidden for every input alias, even when a member flag exists", () => {
  const club = normalizeClub({
    id: 189,
    info_hidden: true,
    info: "placeholder",
    originalInfo: "must not appear",
    raw_text: "must not inspect",
    member: true,
  });
  assert.equal(club.contact, "");
  assert.equal(club.hidden, true);
  assert.equal(Object.hasOwn(club, "raw_text"), false);
  assert.equal(Object.hasOwn(club, "originalInfo"), false);
  assert.equal(
    normalizeClub({ infoHidden: true, originalInfo: "private" }).contact,
    "",
  );
});
test("visitor-visible contact does not require member status", () => {
  assert.equal(
    normalizeClub({
      info_hidden: false,
      info: "public-contact",
      membership_status: null,
    }).contact,
    "public-contact",
  );
});
test("explicit fields decide registration, establishment and application status", () => {
  const club = normalizeClub({
    id: "12",
    country: "japan",
    verified: 0,
    created_at: "2022-02-19",
    verifyMeta: "已登记",
    can_apply: true,
    membership_status: "pending",
  });
  assert.equal(club.registered, false);
  assert.equal(club.established, "2022-02-19");
  assert.equal(club.status, "pending");
  assert.equal(club.canApply, true);
  assert.equal(club.id, 12);
  assert.equal(normalizeClub({ verifyMeta: "已登记" }).registered, null);
});
test("contact links come only from visible contact text and support Discord without a protocol", () => {
  assert.equal(
    visibleContactUrl("联系入口 https://example.org/join"),
    "https://example.org/join",
  );
  assert.equal(
    visibleContactUrl("discord.gg/local-demo"),
    "https://discord.gg/local-demo",
  );
  assert.equal(visibleContactUrl("javascript:alert(1)"), null);
});
test("platforms retain text contacts and full URLs without turning unsafe values into links", () => {
  const items = externalPlatforms(
    "官网: https://example.org/a:b\nQQ：演示群号\nX: javascript:alert(1)\n无分隔符",
  );
  assert.equal(items.length, 3);
  assert.equal(items[0].href, "https://example.org/a:b");
  assert.equal(items[1].href, null);
  assert.equal(items[1].value, "演示群号");
  assert.equal(items[2].href, null);
  for (const value of [
    "data:text/html,hi",
    "javascript:alert(1)",
    "//example.org",
    "example.org",
    "file:///C:/a",
  ])
    assert.equal(safeHttp(value), null);
});
test("pagination deduplicates records while preserving the original order", () => {
  assert.deepEqual(
    appendComments([{ id: 1 }, { id: 2 }], [{ id: "2" }, { id: 3 }]).map(
      (item) => item.id,
    ),
    [1, 2, 3],
  );
});
test("HTTP and API failures remain failures instead of empty content", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: false, status: 503 });
    await assert.rejects(requestJson("/fixture"), /503/);
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ success: false, message: "denied" }),
    });
    await assert.rejects(requestJson("/fixture"), /denied/);
    globalThis.fetch = async (url, options) => {
      assert.equal(options.credentials, "same-origin");
      return { ok: true, json: async () => ({ success: true, data: [] }) };
    };
    assert.deepEqual(await requestJson("/fixture"), {
      success: true,
      data: [],
    });
  } finally {
    globalThis.fetch = original;
  }
});
