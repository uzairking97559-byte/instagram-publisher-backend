"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createMetaClient, MetaError, SCOPES } = require("../lib/meta");

const config = {
  version: "v21.0", callback: "https://publisher.test/auth/meta/callback",
  facebook: { id: "test-facebook-app", secret: "test-facebook-secret" },
  instagram: { id: "test-instagram-app", secret: "test-instagram-secret" }
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("Facebook login re-asks previously declined permissions; Instagram login is unchanged", () => {
  const meta = createMetaClient(config, async () => { throw new Error("no network"); });
  const facebook = new URL(meta.authorizationUrl("facebook", "state-1"));
  assert.equal(facebook.searchParams.get("auth_type"), "rerequest");
  assert.equal(facebook.searchParams.get("scope"), SCOPES.facebook.join(","));
  const instagram = new URL(meta.authorizationUrl("instagram", "state-2"));
  assert.equal(instagram.searchParams.get("auth_type"), null);
  assert.equal(instagram.searchParams.get("force_authentication"), "1");
});

test("Facebook connection without the publish permission names what is missing", async () => {
  const calls = [];
  const meta = createMetaClient(config, async (url) => {
    calls.push(url.pathname);
    return json({ data: SCOPES.facebook.map((permission) => ({
      permission, status: permission === "instagram_content_publish" ? "declined" : "granted"
    })) });
  });
  const error = await meta.discover("facebook", { access_token: "test-user-token" }).catch((caught) => caught);
  assert.ok(error instanceof MetaError);
  assert.equal(error.code, 200);
  assert.deepEqual(error.missing, ["instagram_content_publish"]);
  assert.equal(calls.some((path) => path.endsWith("/me/accounts")), false, "stops before reading Pages");
});

test("Instagram connection is refused when Meta reports no publish permission, accepted otherwise", async () => {
  const meta = createMetaClient(config, async () => json({ user_id: "50001", username: "test_direct" }));
  const token = { access_token: "test-long-ig", expires_in: 5184000, user_id: "50001" };

  const refused = await meta.discover("instagram", { ...token, permissions: "instagram_business_basic" }).catch((caught) => caught);
  assert.ok(refused instanceof MetaError);
  assert.deepEqual(refused.missing, ["instagram_business_content_publish"]);

  const granted = await meta.discover("instagram", { ...token, permissions: "instagram_business_basic, instagram_business_content_publish" });
  assert.equal(granted[0].username, "test_direct");
  assert.deepEqual(granted[0].scopes, ["instagram_business_basic", "instagram_business_content_publish"]);

  const unreported = await meta.discover("instagram", token);
  assert.equal(unreported.length, 1, "a response without a permission list is not treated as a refusal");
});

test("ordinary Meta errors carry no missing-permission list", () => {
  assert.equal(new MetaError({ code: 100 }).missing, null);
  assert.equal(new MetaError({ code: 200, missing: [] }).missing, null);
});
