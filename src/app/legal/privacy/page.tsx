import Link from "next/link";

// Privacy Policy for Orplex Code. Plain, readable, linked from the
// sign-in page. Kept as a server component so it renders without the
// client bundle.

export const metadata = {
  title: "Privacy Policy — Orplex Code",
  description: "What Orplex Code collects, where it goes and how to control it.",
};

const SECTIONS: { heading: string; body: string[] }[] = [
  {
    heading: "1. The short version",
    body: [
      "Your code stays on your machine. We store the account you sign in with, the conversations you have with the agent, and the metadata needed to run the service. Model traffic goes to the provider you configured, under their terms.",
    ],
  },
  {
    heading: "2. What we collect",
    body: [
      "Account data: the email address and display name from your Google or GitHub account, plus your user id, the workspaces you connect and the run history we keep so a conversation can continue across devices.",
      "Product data: prompts, tool calls and their results, kept with the conversation they belong to, so the agent can resume where it left off.",
      "Diagnostics: crash reports and error logs, which contain technical context (version, stack) and are used to fix defects.",
      "We do not sell your personal data, and we do not use your prompts to train third-party models.",
    ],
  },
  {
    heading: "3. Where it goes",
    body: [
      "Model requests: prompts, relevant file contents and tool results are sent to the model provider you configured — for example OpenAI, Anthropic, Google or a local provider. That provider receives the data under its own privacy terms, so choose providers you trust.",
      "Infrastructure: the backend that stores accounts and conversations runs on Vercel, with its database on Supabase. Files you open in the desktop app are not uploaded to us by the app itself; only what a tool or a provider sends leaves your machine.",
      "Authentication: your Google or GitHub identity is handled by that provider and by our OAuth endpoints. We never see your provider password.",
    ],
  },
  {
    heading: "4. API keys and secrets",
    body: [
      "Provider API keys you enter are stored encrypted so the agent can use them on your behalf. They are sent only to the provider they belong to. You can remove a key at any time in Settings, which deletes it.",
      "Keep your own secrets out of prompts unless you intend to send them, and prefer a dedicated workspace for sensitive projects.",
    ],
  },
  {
    heading: "5. Cookies and sessions",
    body: [
      "Signing in sets a session cookie so the app stays logged in. The desktop build also uses a signed session token so the local app can verify that you are signed in without holding a server secret.",
      "We do not use advertising or cross-site tracking cookies.",
    ],
  },
  {
    heading: "6. Retention and deletion",
    body: [
      "Conversations and run history are kept while your account exists, so you can pick up where you left off. Deleting a conversation deletes its contents.",
      "You can request an export or deletion of your account data at any time; write to privacy@orplex.tech and we will action it.",
    ],
  },
  {
    heading: "7. Your choices",
    body: [
      "You can sign out, delete conversations, remove API keys and close your account. You can also ask us for a copy of the data we hold about you.",
      "If you are in a region with data-protection rights, those rights apply to us as a controller of your account data.",
    ],
  },
  {
    heading: "8. Changes and contact",
    body: [
      "If this policy changes materially, we will say so in the app or by email before the change takes effect.",
      "Privacy questions: privacy@orplex.tech. Security reports: security@orplex.tech.",
    ],
  },
];

export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-[var(--bg)] text-[var(--text-primary)]">
      <article className="max-w-[720px] mx-auto px-6 py-16">
        <Link
          href="/auth/signin"
          className="text-[11px] font-['JetBrains_Mono',monospace] text-[var(--brand)] hover:text-[var(--brand-vivid)] transition-colors"
        >
          &larr; Back to sign in
        </Link>
        <h1 className="mt-6 text-[28px] font-['JetBrains_Mono',monospace] font-bold tracking-tight">
          Privacy Policy
        </h1>
        <p className="mt-2 text-[12px] font-['JetBrains_Mono',monospace] text-[var(--text-tertiary)]">
          Orplex Code &middot; last updated 26 October 2026
        </p>

        {SECTIONS.map((section) => (
          <section key={section.heading} className="mt-10">
            <h2 className="text-[15px] font-['JetBrains_Mono',monospace] font-semibold text-[var(--text-primary)]">
              {section.heading}
            </h2>
            {section.body.map((paragraph) => (
              <p
                key={paragraph.slice(0, 32)}
                className="mt-3 text-[13px] leading-[1.75] text-[var(--text-secondary)]"
              >
                {paragraph}
              </p>
            ))}
          </section>
        ))}

        <p className="mt-12 text-[12px] leading-[1.7] text-[var(--text-tertiary)]">
          See also our{" "}
          <Link
            href="/legal/terms"
            className="text-[var(--brand)] hover:text-[var(--brand-vivid)] transition-colors"
          >
            Terms of Service
          </Link>
          .
        </p>
      </article>
    </main>
  );
}
