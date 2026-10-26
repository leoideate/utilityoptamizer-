import { guideText } from "../../src/assistant/instructions";
import { issueTab, toolDefinitions } from "../../src/assistant/tools";
import { assistantEnabled, loadEnv } from "../../src/config/env";

describe("the CRM assistant", () => {
  const base = { DATABASE_URL: "postgresql://u:p@h/db", FIELD_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"), APP_SECRET: "y".repeat(40), STORAGE_DRIVER: "local" };

  it("is on only with the Anthropic key, and can be switched off", () => {
    expect(assistantEnabled(loadEnv(base))).toBe(false);
    expect(assistantEnabled(loadEnv({ ...base, ANTHROPIC_API_KEY: "k" }))).toBe(true);
    expect(assistantEnabled(loadEnv({ ...base, ANTHROPIC_API_KEY: "k", AI_ASSISTANT_ENABLED: "false" }))).toBe(false);
    expect(loadEnv(base)).toMatchObject({ AI_ASSISTANT_MODEL: "claude-haiku-5-5", AI_ASSISTANT_DAILY_LIMIT: 100 });
  });

  it("reads the team guide as plain text, without screenshots or scripts", () => {
    const text = guideText('<style>p{}</style><h2>Documents</h2><p>Upload the bill &amp; LOA.<img src="data:image/png;base64,AAAA"></p><script>x()</script>');
    expect(text).toBe("Documents\nUpload the bill & LOA.");
  });

  it("describes every tool with an object input schema", () => {
    const tools = toolDefinitions();
    expect(tools.map((t) => t.name)).toEqual([
      "get_deal",
      "what_blocks",
      "list_documents",
      "list_tasks",
      "find_deals",
      "energy_details",
      "propose_create_task",
      "propose_complete_task",
      "propose_reschedule_task",
      "propose_set_follow_up",
      "propose_create_lead",
      "propose_update_deal",
      "propose_move_stage",
      "propose_log_note",
      "propose_send_email",
    ]);
    for (const t of tools) expect(t.input_schema.type).toBe("object");
  });

  it("links each blocking issue to the tab that fixes it", () => {
    expect(issueTab("All required documents must be received and approved.", true)).toBe("documents");
    expect(issueTab("Enter an MPRN for each electricity meter.", true)).toBe("energy");
  });
});
