import { describe, expect, it } from "vitest";
import { isBatonError } from "../src/errors.js";
import { renderPrompt } from "../src/prompt/builder.js";
import { makeIssue } from "./helpers.js";

describe("renderPrompt (SPEC §5.4, §12)", () => {
  it("renders issue fields and null attempt on first run", async () => {
    const issue = makeIssue({ labels: ["bug", "ai-ready"] });
    const template =
      "Work on {{ issue.repository }}#{{ issue.number }}: {{ issue.title }}\n" +
      "Labels:{% for l in issue.labels %} {{ l }}{% endfor %}\n" +
      "{% if attempt %}Retry {{ attempt }}{% else %}First run{% endif %}";
    const result = await renderPrompt(template, issue, null);
    expect(result).toContain("Work on acme/repo#1: Test issue");
    expect(result).toContain("Labels: bug ai-ready");
    expect(result).toContain("First run");
  });

  it("renders the attempt number on retries", async () => {
    const result = await renderPrompt(
      "{% if attempt %}attempt={{ attempt }}{% endif %}",
      makeIssue(),
      3,
    );
    expect(result).toBe("attempt=3");
  });

  it("fails on unknown variables (strict mode)", async () => {
    expect.assertions(1);
    try {
      await renderPrompt("Hello {{ bogus_variable }}", makeIssue(), null);
    } catch (err) {
      expect(isBatonError(err, "template_render_error")).toBe(true);
    }
  });

  it("fails on unknown filters (strict mode)", async () => {
    expect.assertions(1);
    try {
      await renderPrompt("{{ issue.title | bogus_filter }}", makeIssue(), null);
    } catch (err) {
      expect(
        isBatonError(err, "template_parse_error") ||
          isBatonError(err, "template_render_error"),
      ).toBe(true);
    }
  });

  it("exposes blockers for iteration", async () => {
    const issue = makeIssue({
      blockedBy: [
        { id: "I_9", identifier: "repo-9", state: "Todo", terminal: false },
      ],
    });
    const result = await renderPrompt(
      "{% for b in issue.blocked_by %}blocked by {{ b.identifier }}{% endfor %}",
      issue,
      null,
    );
    expect(result).toBe("blocked by repo-9");
  });
});
