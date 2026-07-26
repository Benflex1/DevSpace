import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { IncidentReference } from "./incident-reference.js";

describe("Workbench incident reference", () => {
  test("renders accessible copyable text only when an incident exists", () => {
    expect(renderToStaticMarkup(<IncidentReference />)).toBe("");
    expect(renderToStaticMarkup(
      <IncidentReference incidentId="018f0f00-0000-7000-8000-000000000099" />
    )).toContain("Reference ID: <code>018f0f00-0000-7000-8000-000000000099</code>");
  });
});
