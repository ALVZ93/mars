import test from "node:test";
import assert from "node:assert/strict";
import { Emitter } from "../src/emitter.js";

test("on runs every time", () => { const e = new Emitter(); let n = 0; e.on("x", () => n++); e.emit("x"); e.emit("x"); assert.equal(n, 2); });
test("unsubscribe", () => { const e = new Emitter(); let n = 0; const off = e.on("x", () => n++); off(); e.emit("x"); assert.equal(n, 0); });
