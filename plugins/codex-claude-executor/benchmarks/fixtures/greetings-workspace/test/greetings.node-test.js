import test from "node:test";
import assert from "node:assert/strict";
import { greet } from "../src/greetings.js";

test("greet returns the expected salutation", () => {
  assert.equal(greet("Taylor"), "Hello, Taylor!");
});
