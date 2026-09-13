import { createHash } from "node:crypto";
import { aiProfileRevisionSchema, canonicalizeAiProviderAuthorityV1 } from "@devspace/contracts";

const AI_PROFILE_REVISION_DOMAIN = "devspace.ai-provider-profile-revision/v1";

export function hashAiProviderAuthorityV1(input: unknown): string {
  const hash = createHash("sha256");
  hash.update(AI_PROFILE_REVISION_DOMAIN, "utf8");
  hash.update(Uint8Array.of(0));
  hash.update(canonicalizeAiProviderAuthorityV1(input), "utf8");
  return aiProfileRevisionSchema.parse(`sha256-ai-profile-v1:${hash.digest("hex")}`);
}
