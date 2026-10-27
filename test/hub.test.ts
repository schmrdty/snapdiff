import { test } from "node:test";
import assert from "node:assert/strict";
import { isNotFound } from "../src/hub.js";

test("isNotFound: upstream errCode, Hypersnap 400 wrapper, and validation errors", () => {
  assert.equal(isNotFound(404, null), true);
  assert.equal(isNotFound(400, { errCode: "not_found", details: "message not found" }), true);
  // Observed on haatz.quilibrium.com (Hypersnap 0.15.0) for a missing cast.
  assert.equal(
    isNotFound(400, {
      error: "Failed to get cast",
      error_detail: 'status: NotFound, message: "cast not found", details: [], metadata: MetadataMap { headers: {} }',
    }),
    true,
  );
  // A bad request must stay an error, never "absent".
  assert.equal(isNotFound(400, { errCode: "bad_request.validation_failure", details: "fid must be an integer" }), false);
  assert.equal(isNotFound(500, { error: "Failed to get cast", error_detail: "status: Internal, message: boom" }), false);
  assert.equal(isNotFound(400, "plain text"), false);
});
