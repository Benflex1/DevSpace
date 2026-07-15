import { expect, expectTypeOf, test } from "vitest";
import {
  agentApiV1EndpointByOperation,
  createWorkspaceDataSchema,
  healthDataSchema,
  mutationReceiptSchema,
  type AgentApiV1Operation
} from "@devspace/contracts";

type AssertFalse<Value extends false> = Value;
type OperationCollapsedToString = string extends AgentApiV1Operation ? true : false;

test("endpoint declarations retain exact operation and transport literals", () => {
  const operationIsNotString: AssertFalse<OperationCollapsedToString> = false;
  expect(operationIsNotString).toBe(false);

  const create = agentApiV1EndpointByOperation["workspace.create"];
  expectTypeOf(create.operation).toEqualTypeOf<"workspace.create">();
  expectTypeOf(create.method).toEqualTypeOf<"POST">();
  expectTypeOf(create.path).toEqualTypeOf<"/v1/workspaces/create">();
  expectTypeOf(create.classification).toEqualTypeOf<"mutation">();
  expectTypeOf(create.journaledMutation).toEqualTypeOf<true>();
  expectTypeOf(create.successStatus).toEqualTypeOf<202>();
  expectTypeOf(create.requestDataSchema).toEqualTypeOf<typeof createWorkspaceDataSchema>();
  expectTypeOf(create.requestBodySchema.shape.data).toEqualTypeOf<typeof createWorkspaceDataSchema>();
  expectTypeOf(create.successDataSchema).toEqualTypeOf<typeof mutationReceiptSchema>();
  expectTypeOf(create.successBodySchema.shape.data).toEqualTypeOf<typeof mutationReceiptSchema>();

  const health = agentApiV1EndpointByOperation["agent.health.get"];
  expectTypeOf(health.operation).toEqualTypeOf<"agent.health.get">();
  expectTypeOf(health.method).toEqualTypeOf<"GET">();
  expectTypeOf(health.path).toEqualTypeOf<"/v1/health">();
  expectTypeOf(health.classification).toEqualTypeOf<"non-mutating">();
  expectTypeOf(health.journaledMutation).toEqualTypeOf<false>();
  expectTypeOf(health.successStatus).toEqualTypeOf<200>();
  expectTypeOf(health.successDataSchema).toEqualTypeOf<typeof healthDataSchema>();
  expectTypeOf(health.successBodySchema.shape.data).toEqualTypeOf<typeof healthDataSchema>();

  const stream = agentApiV1EndpointByOperation["terminal.stream"];
  expectTypeOf(stream.pathParametersSchema.shape.terminalId).not.toBeUnknown();
  expectTypeOf(stream.successBodySchema).toEqualTypeOf<null>();
});
