"use server";

import { getServerSession } from "next-auth";
import { jwtOnlyOptions as authOptions } from "@/lib/auth";
import { bugReportSchema } from "@/lib/validators";
import { checkRateLimit } from "@/lib/rate-limiter";
import nodemailer from "nodemailer";

export async function submitBugReport(data: { title: string; description: string; severity: string }) {
  const session = await getServerSession(authOptions);

  // Rate limit
  const identifier = session?.user?.id || "anonymous";
  const rateLimit = checkRateLimit(`bug-report:${identifier}`);
  if (!rateLimit.allowed) {
    return { success: false, message: "Too many reports. Please try again later." };
  }

  // Validate
  const parsed = bugReportSchema.safeParse(data);
  if (!parsed.success) {
    return { success: false, message: "Invalid input." };
  }

  // Send email
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });

  const userEmail = session?.user?.email || process.env.GMAIL_USER;

  await transporter.sendMail({
    from: process.env.GMAIL_USER,
    to: "chandyash400@gmail.com",
    subject: `[Orplex Bug Report] ${data.severity.toUpperCase()}: ${data.title}`,
    html: `
      <h2>Bug Report</h2>
      <p><strong>Title:</strong> ${data.title}</p>
      <p><strong>Severity:</strong> ${data.severity}</p>
      <p><strong>Reporter:</strong> ${userEmail}</p>
      <hr />
      <p><strong>Description:</strong></p>
      <p>${data.description.replace(/\n/g, "<br />")}</p>
    `,
  });

  return { success: true, message: "Bug report sent successfully." };
}
