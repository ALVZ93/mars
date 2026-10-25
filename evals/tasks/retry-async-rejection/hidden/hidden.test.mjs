import test from "node:test";
import assert from "node:assert/strict";
import { retry } from "../src/retry.js";

test("retries async rejections", async () => {
  let calls = 0;
  assert.equal(await retry(async () => { if (++calls < 3) throw new Error("fail " + calls); return "ok"; }, 3), "ok");
  assert.equal(calls, 3);
});
test("rejects with the last async error", async () => {
  let calls = 0;
  await assert.rejects(retry(async () => { throw new Error("fail " + ++calls); }, 2), /fail 2/);
  assert.equal(calls, 2);
});
test("sync behaviour kept", async () => assert.equal(await retry(() => 7), 7));
