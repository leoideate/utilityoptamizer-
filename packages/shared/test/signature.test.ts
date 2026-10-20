import { DEFAULT_SIGNATURE_STYLE, type CompanySignature, type EmailSignature, emailSignatureSchema, renderSignature, withSignature } from "../src";

const company: CompanySignature = { companyName: "Utility Optimizer Limited", address: "First Floor, Greenhills Road\nDublin 12, D12NP98", phone: "085 8566667", website: "utilityoptimizer.ie", email: null, disclaimer: null };
const sig: EmailSignature = { enabled: true, fullName: "Aamir Noshad", jobTitle: "Energy Consultant", phone: null, mobile: "087 123 4567", email: "aamir@example.ie", extra: null, ...DEFAULT_SIGNATURE_STYLE };
const images = { company: "https://crm.example/logo.png", own: "https://crm.example/me.png" };

describe("email signatures", () => {
  it("renders the same details as HTML and text, with the company block", () => {
    const { html, text } = renderSignature(sig, company, images);
    expect(text).toBe("Aamir Noshad\nEnergy Consultant\nM 087 123 4567\naamir@example.ie\n\nUtility Optimizer Limited\nFirst Floor, Greenhills Road\nDublin 12, D12NP98\nT 085 8566667 · utilityoptimizer.ie");
    expect(html).toContain('src="https://crm.example/logo.png"');
    expect(html).toContain('href="https://utilityoptimizer.ie"');
    expect(html).toContain('href="mailto:aamir@example.ie"');
  });

  it("uses the person's own picture, or none, and can leave out the company block", () => {
    expect(renderSignature({ ...sig, image: "own" }, company, images).html).toContain("me.png");
    const bare = renderSignature({ ...sig, image: "none", showCompany: false }, company, images);
    expect(bare.html).not.toContain("<img");
    expect(bare.text).not.toContain("Greenhills");
  });

  it("escapes everything typed, so a signature can't inject markup or styles", () => {
    const evil = renderSignature({ ...sig, fullName: '<script>alert(1)</script>', extra: '"><img src=x onerror=alert(1)>', accentColor: "red;background:url(x)" }, company, images);
    expect(evil.html).not.toMatch(/<script|<img src=x|onerror=alert\(1\)>/);
    expect(evil.html).not.toContain("url(x)");
    expect(emailSignatureSchema.safeParse({ ...sig, accentColor: "red;x" }).success).toBe(false);
  });

  it("appends the signature to a message as text and HTML", () => {
    const m = withSignature("Hi Mary,\n\nPlease find <details> below.", renderSignature(sig, company, images));
    expect(m.text).toMatch(/below\.\n\n-- \nAamir Noshad/);
    expect(m.html).toContain("Hi Mary,<br><br>Please find &lt;details&gt; below.");
    expect(withSignature("Hi", null)).toEqual({ text: "Hi" });
  });
});
