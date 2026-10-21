import { afterEach, describe, expect, it, vi } from "vitest";
import { reportError, setErrorReporter } from "./report";

afterEach(() => setErrorReporter(null));

describe("reportError", () => {
  it("is a no-op when no reporter is installed", () => {
    expect(() => reportError(new Error("boom"), { tool: "t" })).not.toThrow();
  });

  it("forwards the error and context to the installed reporter", () => {
    const reporter = vi.fn();
    setErrorReporter(reporter);
    const err = new Error("boom");
    reportError(err, { tool: "hutch_query_records", organizationId: "org-1" });
    expect(reporter).toHaveBeenCalledWith(err, { tool: "hutch_query_records", organizationId: "org-1" });
  });

  it("defaults context to an empty object", () => {
    const reporter = vi.fn();
    setErrorReporter(reporter);
    reportError("x");
    expect(reporter).toHaveBeenCalledWith("x", {});
  });

  it("swallows reporter failures", () => {
    setErrorReporter(() => {
      throw new Error("reporter down");
    });
    expect(() => reportError(new Error("boom"))).not.toThrow();
  });

  it("shares the reporter across separate copies of the module", async () => {
    const reporter = vi.fn();
    setErrorReporter(reporter);
    vi.resetModules();
    const copy = await import("./report");
    const err = new Error("boom");
    copy.reportError(err, { tool: "t" });
    expect(reporter).toHaveBeenCalledWith(err, { tool: "t" });
  });

  it("stops reporting after the reporter is cleared", () => {
    const reporter = vi.fn();
    setErrorReporter(reporter);
    setErrorReporter(null);
    reportError(new Error("boom"));
    expect(reporter).not.toHaveBeenCalled();
  });
});
