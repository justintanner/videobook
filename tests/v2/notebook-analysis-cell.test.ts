import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AnalysisCellSummary } from "../../src/components/videobook/AnalysisCellSummary";
import { notebookAnalysisLlmExchanges } from "../../src/videobook/notebook-cell-presentation";

describe("AnalysisCellSummary", () => {
  it("keeps the shot summary and exposes the canonical output JSON", () => {
    const html = renderToStaticMarkup(createElement(AnalysisCellSummary, {
      analysisInfo: {
        sourceDurationSeconds: 30,
        outputJson: {
          version: 2,
          request: {
            provider: "openai",
            model: "gpt-5.6-sol",
            mode: "live",
          },
          raw: {
            shots: [
              {
                startSeconds: 0,
                endSeconds: 15,
                label: "Opening",
                prompt: "The presenter opens the segment.",
              },
              {
                startSeconds: 15,
                endSeconds: 30,
                label: "Closing",
                prompt: "The presenter closes the segment.",
              },
            ],
          },
        },
        shots: [
          {
            ordinal: 1,
            label: "Opening",
            startSeconds: 0,
            endSeconds: 15,
            durationSeconds: 15,
          },
          {
            ordinal: 2,
            label: "Closing",
            startSeconds: 15,
            endSeconds: 30,
            durationSeconds: 15,
          },
        ],
      },
    }));

    expect(html).toContain("2 shots");
    expect(html).toContain("Opening");
    expect(html).toContain("Output JSON");
    expect(html).toContain('aria-label="Analysis output JSON"');
    expect(html).toContain("gpt-5.6-sol");
    expect(html).toContain("live");
    expect(html).toContain("<details");
    expect(html).not.toContain("<details open");
  });

  it("does not show an output disclosure while analysis is pending", () => {
    const html = renderToStaticMarkup(createElement(AnalysisCellSummary, {
      analysisInfo: null,
      fallbackShotCount: 0,
      fallbackSourceDurationSeconds: 30,
    }));

    expect(html).toContain("Analysis pending");
    expect(html).not.toContain("Output JSON");
  });

  it("preserves complete recorded LLM exchanges and supports legacy outputs", () => {
    const input = {
      model: "gpt-5.6-sol",
      input: [{ role: "user", content: "Analyze this source." }],
    };
    const response = {
      id: "resp-analysis",
      status: "completed",
      output: [],
    };

    expect(notebookAnalysisLlmExchanges({
      llmExchanges: [{
        provider: "openai",
        model: "gpt-5.6-sol",
        stage: "notebook_shot_labels",
        input,
        response,
      }],
    })).toEqual([{
      complete: true,
      provider: "openai",
      model: "gpt-5.6-sol",
      stage: "notebook_shot_labels",
      input,
      response,
    }]);

    expect(notebookAnalysisLlmExchanges({
      request: {
        provider: "openai",
        model: "gpt-5.6-sol",
        mode: "live",
      },
      raw: { shots: [] },
    })).toEqual([{
      complete: false,
      provider: "openai",
      model: "gpt-5.6-sol",
      stage: "legacy_analysis",
      input: {
        provider: "openai",
        model: "gpt-5.6-sol",
        mode: "live",
      },
      response: { shots: [] },
    }]);
  });
});
