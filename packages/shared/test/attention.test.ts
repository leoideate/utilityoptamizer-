import { MIN_STUCK_DAYS, STUCK_AFTER_DAYS, attentionSummary, daysAtStage, isStuck } from "../src";

const at = (iso: string) => new Date(`${iso}T09:00:00Z`);

describe("stuck deal thresholds", () => {
  it("gives each stage its limit", () => {
    expect(STUCK_AFTER_DAYS).toEqual({
      new_lead: 7,
      call_scheduled: 7,
      contacted: 7,
      interested: 7,
      details_requested: 7, // early stage, although the customer has the ball
      details_received: 7,
      comparison_prepared: 14,
      proposal_sent: 10,
      client_reviewing: 10,
      supplier_selected: 14,
      documents_prepared: 14,
      awaiting_signature: 10,
      internal_review: 14,
      submitted: 7,
      compliance_query: 7,
      awaiting_confirmation: 7,
      live_won: null,
      renewal_scheduled: null,
    });
    expect(MIN_STUCK_DAYS).toBe(7);
  });

  it("counts Irish calendar days at the stage", () => {
    // Irish winter time is UTC, so 23:30 UTC is still the same day.
    expect(daysAtStage(new Date("2026-10-31T23:30:00Z"), at("2026-11-01"))).toBe(1);
    // In summer time 23:30 UTC is 00:30 the next day in Dublin.
    expect(daysAtStage(new Date("2026-07-01T23:30:00Z"), at("2026-07-02"))).toBe(0);
  });

  it("is stuck only after the limit, while open and with nothing planned", () => {
    const deal = { stage: "proposal_sent" as const, outcome: "open" as const, stageEnteredAt: at("2026-10-01"), hasOpenActivity: false };
    expect(isStuck(deal, at("2026-10-11"))).toBe(false); // exactly 10 days
    expect(isStuck(deal, at("2026-10-12"))).toBe(true);
    expect(isStuck({ ...deal, hasOpenActivity: true }, at("2026-10-30"))).toBe(false);
    expect(isStuck({ ...deal, outcome: "lost" }, at("2026-10-30"))).toBe(false);
    expect(isStuck({ ...deal, stage: "comparison_prepared" }, at("2026-10-12"))).toBe(false);
    expect(isStuck({ ...deal, stage: "comparison_prepared" }, at("2026-10-16"))).toBe(true);
    expect(isStuck({ ...deal, stage: "submitted" }, at("2026-10-09"))).toBe(true);
  });

  it("never treats live or renewal-scheduled deals as stuck", () => {
    for (const stage of ["live_won", "renewal_scheduled"] as const) {
      expect(isStuck({ stage, outcome: "open", stageEnteredAt: at("2020-01-01"), hasOpenActivity: false }, at("2026-10-26"))).toBe(false);
    }
  });
});

describe("morning summary text", () => {
  it("lists only what there is, with plurals", () => {
    expect(attentionSummary({ stuck: 3, overdueTasks: 2, followUps: 0, renewals: 1 })).toBe("3 deals stuck, 2 overdue tasks, 1 renewal due");
    expect(attentionSummary({ stuck: 1, overdueTasks: 0, followUps: 2, renewals: 0 })).toBe("1 deal stuck, 2 follow-ups due");
    expect(attentionSummary({ stuck: 0, overdueTasks: 0, followUps: 0, renewals: 0 })).toBe("");
  });
});
