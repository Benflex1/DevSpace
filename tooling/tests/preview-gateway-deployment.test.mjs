import assert from "node:assert/strict";
import test from "node:test";
import { validatePreviewGatewayDeployment } from "../check-preview-gateway-deployment.mjs";

test("preview gateway deployment artifacts satisfy the repository contract", async () => {
  assert.equal(await validatePreviewGatewayDeployment(), true);
});
