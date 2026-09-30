import { NextRequest, NextResponse } from "next/server";
import nodemailer from "nodemailer";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions as authOptions } from "@/lib/auth";
import { bugReportSchema, sanitize, isValidEmail } from "@/lib/validators";
import { checkRateLimit } from "@/lib/rate-limiter";

// NB: created LAZILY, not at module scope. Building the transporter eagerly
// crashed `next build` on CI (no Gmail creds there): the non-null-asserted
// env vars are undefined at page-data collection, so `.replace` on the
// password threw during module evaluation.
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const BUG_RECIPIENT = process.env.BUG_REPORT_RECIPIENT;

let cachedTransporter: ReturnType<typeof nodemailer.createTransport> | null = null;
function getTransporter(): ReturnType<typeof nodemailer.createTransport> | null {
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) return null;
  if (!cachedTransporter) {
    cachedTransporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: GMAIL_USER,
        pass: GMAIL_APP_PASSWORD.replace(/\s/g, ""),
      },
      secure: true,
      tls: { rejectUnauthorized: true },
    });
  }
  return cachedTransporter;
}

function getBugRecipient(fallback: string): string | null {
  if (BUG_RECIPIENT && BUG_RECIPIENT.trim()) return BUG_RECIPIENT.trim();
  return GMAIL_USER?.trim() || fallback || null;
}

export async function POST(request: NextRequest) {
  try {
    const ip = request.headers.get("x-forwarded-for") || request.headers.get("x-real-ip") || "unknown";

    // Start auth, rate limit, and body parse in parallel (no dependencies between them)
    const [session, body] = await Promise.all([
      getServerSession(authOptions).catch(() => null),
      request.json(),
    ]);

    const rateLimit = checkRateLimit(`bug-report:${ip}`);
    if (!rateLimit.allowed) {
      return NextResponse.json(
        { success: false, message: `Rate limit exceeded. Try again in ${Math.ceil((rateLimit.resetAt - Date.now()) / 1000)}s.` },
        { status: 429 }
      );
    }

    const parsed = bugReportSchema.safeParse(body);
    if (!parsed.success) {
      // SECURITY: Never leak internal validation details to client
      // Log details server-side only for debugging
      console.warn("[Bug Report] Validation failed:", parsed.error.errors);
      return NextResponse.json(
        { success: false, message: "Invalid input. Please check all fields and try again." },
        { status: 400 }
      );
    }

    const { title, description, severity } = parsed.data;
    const cleanTitle = sanitize(title);
    const cleanDescription = sanitize(description);

    // Use already-fetched session (no second call)
    let reporterEmail = "anonymous@orplex.tech";
    if (session?.user?.email && isValidEmail(session.user.email)) {
      reporterEmail = session.user.email;
    }

    const severityEmoji = severity === "high" ? "\uD83D\uDD34" : severity === "medium" ? "\uD83D\uDFE1" : "\uD83D\uDFE2";
    const htmlContent = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #050505; padding: 24px; border-radius: 8px;">
          <h2 style="color: #f59e0b; margin: 0 0 16px 0;">${severityEmoji} Bug Report — Orplex Tech</h2>
          <table style="width: 100%; border-collapse: collapse; color: #e5e2e1;">
            <tr>
              <td style="padding: 8px 12px; font-weight: bold; color: #d8c3ad; border-bottom: 1px solid #353534;">Reporter</td>
              <td style="padding: 8px 12px; border-bottom: 1px solid #353534;">${reporterEmail}</td>
            </tr>
            <tr>
              <td style="padding: 8px 12px; font-weight: bold; color: #d8c3ad; border-bottom: 1px solid #353534;">Severity</td>
              <td style="padding: 8px 12px; border-bottom: 1px solid #353534;">${severityEmoji} ${severity.toUpperCase()}</td>
            </tr>
            <tr>
              <td style="padding: 8px 12px; font-weight: bold; color: #d8c3ad; border-bottom: 1px solid #353534;">Title</td>
              <td style="padding: 8px 12px; border-bottom: 1px solid #353534;">${cleanTitle}</td>
            </tr>
            <tr>
              <td style="padding: 8px 12px; font-weight: bold; color: #d8c3ad;">Description</td>
              <td style="padding: 8px 12px; white-space: pre-wrap;">${cleanDescription}</td>
            </tr>
          </table>
          <p style="color: #a08e7a; font-size: 11px; margin-top: 16px; border-top: 1px solid #353534; padding-top: 12px;">
            Sent from Orplex Tech IDE &bull; ${new Date().toISOString()} &bull; IP: ${ip}
          </p>
        </div>
      </div>
    `;

    const transporter = getTransporter();
    const recipient = getBugRecipient(reporterEmail);
    if (!transporter || !recipient) {
      // Mail not configured on this deployment (e.g. CI/preview builds) —
      // report is logged instead of emailed.
      console.warn("[Bug Report API] mail not configured (GMAIL_USER/GMAIL_APP_PASSWORD/BUG_REPORT_RECIPIENT missing) — report dropped");
      return NextResponse.json(
        { success: false, message: "Bug reporting is not configured on this deployment." },
        { status: 503 }
      );
    }

    await transporter.sendMail({
      from: `"Orplex Tech Bug Bot" <${GMAIL_USER}>`,
      to: recipient,
      replyTo: reporterEmail !== "anonymous@orplex.tech" ? reporterEmail : undefined,
      subject: `${severityEmoji} [${severity.toUpperCase()}] Orplex Tech Bug: ${cleanTitle}`,
      text: `Reporter: ${reporterEmail}\nSeverity: ${severity}\nTitle: ${cleanTitle}\n\n${cleanDescription}`,
      html: htmlContent,
    });

    return NextResponse.json({ success: true, message: "Bug report sent successfully! Thank you." });
  } catch (error) {
    console.error("[Bug Report API] Error:", error);
    return NextResponse.json(
      { success: false, message: "Internal server error. Please try again later." },
      { status: 500 }
    );
  }
}
