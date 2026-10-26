import Link from "next/link";

// Terms of Service for Orplex Code. Plain, readable, linked from the
// sign-in page. Kept as a server component so it renders without the
// client bundle.

export const metadata = {
  title: "Terms of Service — Orplex Code",
  description: "The terms you agree to when you use Orplex Code.",
};

const SECTIONS: { heading: string; body: string[] }[] = [
  {
    heading: "1. What Orplex Code is",
    body: [
      "Orplex Code is a desktop application that runs AI-assisted software work on your own computer. It includes an agent that can read and edit the files in the workspace you open, run commands with your permission, and talk to the model providers you configure.",
      "The desktop app is a client. Accounts, sessions and shared run history are served by our backend; the agent itself runs locally, against the files on your machine.",
    ],
  },
  {
    heading: "2. Accounts",
    body: [
      "You sign in with a Google or GitHub account. You are responsible for what happens under your account, including keeping access to the provider account secure and for activity that uses your API keys.",
      "You must be old enough to enter a contract where you live, and you may not use Orplex Code if doing so is prohibited by law or by your provider's terms.",
    ],
  },
  {
    heading: "3. Acceptable use",
    body: [
      "Do not use Orplex Code to break the law, to attack other people's systems, to generate malware, to harvest credentials, or to circumvent the limits of a model provider or of this service.",
      "Do not use the service to infringe someone else's rights, and do not attempt to gain access to accounts, workspaces or data that are not yours.",
      "We may suspend or terminate an account that violates these terms, or that creates a risk of harm to us or to other people.",
    ],
  },
  {
    heading: "4. Your code, your prompts, your keys",
    body: [
      "Your workspace stays on your machine unless a tool you run — or a provider you configure — sends it somewhere. The agent acts on the folder you open, using your permissions and your environment.",
      "Prompts, context and tool results are sent to the model provider you configured, under that provider's terms. If you configure a provider key, you are entering a contract with that provider for that traffic.",
      "You keep ownership of your code and prompts. You grant us only the rights needed to run the service for you, such as storing your conversations so you can continue them later.",
    ],
  },
  {
    heading: "5. Acceptable output",
    body: [
      "The output of a language model is generated, not guaranteed. It can be wrong, incomplete, or unsafe. You are responsible for reviewing what the agent writes and for what you run.",
      "Keep backups of anything you cannot afford to lose, and review changes before they reach production.",
    ],
  },
  {
    heading: "6. Availability and changes",
    body: [
      "We work to keep Orplex Code running, but the service is provided as-is, without a guaranteed uptime or response time. Features may change or be withdrawn.",
      "We may update these terms. If a change is material, we will tell you in the app or by email before it takes effect. Continuing to use Orplex Code after that means you accept the updated terms.",
    ],
  },
  {
    heading: "7. Disclaimer and liability",
    body: [
      "To the maximum extent allowed by law, Orplex Code and its maintainers are not liable for lost data, lost profit, or any indirect or consequential damage arising from your use of the service.",
      "Nothing in these terms limits liability that cannot be limited by law, including liability for intent or gross negligence.",
    ],
  },
  {
    heading: "8. Contact",
    body: [
      "Questions about these terms can be sent to legal@orplex.tech, or through the support channel in the app.",
    ],
  },
];

export default function TermsPage() {
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
          Terms of Service
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
            href="/legal/privacy"
            className="text-[var(--brand)] hover:text-[var(--brand-vivid)] transition-colors"
          >
            Privacy Policy
          </Link>
          .
        </p>
      </article>
    </main>
  );
}
