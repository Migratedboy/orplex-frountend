import { NextResponse } from "next/server";
import { mintDesktopCode, DESKTOP_FLOW_COOKIE } from "@/lib/desktop-auth";
import { checkRateLimit, clientIp } from "@/lib/rate-limiter";

export const dynamic = "force-dynamic";

function page(body: string): NextResponse {
  return new NextResponse(
    `<!doctype html><meta charset="utf-8"><title>Orplex Code — sign in</title>` +
      `<body style="font-family:system-ui;background:#141414;color:#eee;display:grid;place-items:center;height:100vh;margin:0">` +
      `<div style="text-align:center;max-width:420px">${body}</div></body>`,
    { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

export async function GET(request: Request) {
  const rl = checkRateLimit(`desktop-start:${clientIp(request)}`);
  if (!rl.allowed) {
    return page(`<h2 style="color:#ff6b00">Too many sign-in attempts</h2><p style="color:#9aa">Wait a minute and try again.</p>`);
  }
  const provider = (new URL(request.url).searchParams.get("provider") || "google").toLowerCase();
  if (provider !== "google" && provider !== "github") {
    return page(`<h2 style="color:#ff6b00">Unsupported provider</h2><p style="color:#9aa">Use google or github.</p>`);
  }
  const configured =
    provider === "google"
      ? !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET)
      : !!(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET);
  if (!configured) {
    return page(
      `<h2 style="color:#ff6b00">${provider} sign-in is not configured</h2><p style="color:#9aa">Set the ${provider.toUpperCase()}_CLIENT_ID / _CLIENT_SECRET env vars on the backend.</p>`
    );
  }

  // One-time code: the finish route arms it with the session user after OAuth,
  // and the app's exchange call burns it in return for a session cookie.
  // The flow cookie binds the code to THIS browser (login-CSRF defense) —
  // HttpOnly so page JS (and any XSS) cannot read it; SameSite=Lax so it
  // rides the OAuth callback navigation back.
  const { code, flowToken } = mintDesktopCode(provider);
  const callbackUrl = `/api/auth/desktop/finish?code=${encodeURIComponent(code)}`;
  const res = page(
    `<h2 style="color:#ff6b00">Taking you to ${provider === "google" ? "Google" : "GitHub"}…</h2>` +
      `<p style="color:#9aa">Complete sign-in there; Orplex Code will reopen automatically.</p>` +
      `<script>
        fetch("/api/auth/csrf", { credentials: "same-origin" })
          .then((r) => r.json())
          .then(({ csrfToken }) => {
            const f = document.createElement("form");
            f.method = "POST";
            f.action = "/api/auth/signin/${provider}";
            for (const [n, v] of Object.entries({ csrfToken, callbackUrl: ${JSON.stringify(callbackUrl)} })) {
              const i = document.createElement("input");
              i.type = "hidden"; i.name = n; i.value = v; f.appendChild(i);
            }
            document.body.appendChild(f);
            f.submit();
          })
          .catch(() => { document.body.innerHTML = '<h2 style="color:#ff6b00">Sign-in could not start</h2><p style="color:#9aa">Return to the app and try again.</p>'; });
      </script>`
  );
  res.cookies.set(DESKTOP_FLOW_COOKIE, flowToken, {
    httpOnly: true,
    sameSite: "lax",
    path: "/api/auth/desktop",
    maxAge: 600,
    ...(process.env.NODE_ENV === "production" ? { secure: true } : {}),
  });
  return res;
}
