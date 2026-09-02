"use client";

import { signIn, getProviders } from "next-auth/react";
import { useState, useEffect } from "react";

export default function SignInPage() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [availableProviders, setAvailableProviders] = useState<Record<string, { name: string; id: string }>>({});

  // Fetch available providers from NextAuth so we only show buttons
  // for providers that have valid credentials configured.
  useEffect(() => {
    getProviders().then((p) => p && setAvailableProviders(p)).catch(() => {});
  }, []);

  const handleOAuth = async (provider: "google" | "github") => {
    setLoading(true);
    setError("");
    try {
      await signIn(provider, { callbackUrl: "/" });
    } catch {
      setError("Authentication failed. Please try again.");
      setLoading(false);
    }
  };

  const hasGoogle = !!availableProviders["google"];
  const hasGitHub = !!availableProviders["github"];

  return (
    <div className="bg-[#f9f9fa] min-h-screen flex font-['Lexend',sans-serif] text-[#1a1c1d] antialiased">
      {/* Left Panel - Branding (desktop only) */}
      <div className="hidden md:flex md:w-1/2 relative bg-[#dadadb] items-end justify-start p-[64px]">
        {/* Background gradient overlay */}
        <div className="absolute inset-0 z-0">
          <div
            className="bg-cover bg-center w-full h-full opacity-60"
            style={{
              backgroundImage:
                "url('https://lh3.googleusercontent.com/aida-public/AB6AXuCuoiHm68KaOzmGbXR5YLCW0rpSdPCm5oP6Lx7Sp76nUKt7sWu91_rH4CfdIPyus8i7pgqv0cHBRghSBVv3sMUU-Psh64f1Dzb6yDV44EjbghViIGBbp2AMrROb5cb5XVJ2X5FBosPNZZWw2ThhvavA0dkhpAng1ZyoXcjpLXQGVUFX9mJnFd68Y_cuT2ETRVpsoydWRftqHbgpxDZYxoasMGJcgOxokFyuba3fUGB3VEdiOs_teYBV')",
            }}
          />
          <div className="absolute inset-0 bg-gradient-to-t from-[#dadadb] via-transparent to-transparent" />
        </div>
        <div className="relative z-10 w-full max-w-md">
          <div className="mb-[24px]">
            {/* Logo */}
            <div className="h-16 w-16 rounded-lg overflow-hidden mb-[4px]">
              <img src="/logo.png" alt="Orplex Tech" className="w-full h-full object-cover" />
            </div>
          </div>
          <h1 className="text-[64px] font-bold leading-[1.1] tracking-[-0.03em] text-[#1a1c1d] mb-[4px]">
            ORPLEX
          </h1>
          <p
            className="text-[10px] font-bold text-[#ff6b00] tracking-[0.15em] uppercase border-l-4 border-[#ff6b00] pl-[4px]"
            style={{ lineHeight: "1" }}
          >
            ARCHITECTING TOMORROW.
            <br />
            SECURE SYSTEM ACCESS INITIALIZED.
          </p>
        </div>
      </div>

      {/* Right Panel - Auth Form */}
      <div className="w-full md:w-1/2 flex items-center justify-center p-[32px] md:p-[64px] bg-white relative z-20">
        <div className="w-full max-w-[384px] flex flex-col gap-[32px]">
          {/* Mobile Logo */}
          <div className="md:hidden flex flex-col items-center gap-[4px] text-center">
            <div className="h-20 w-20 rounded-lg overflow-hidden mb-[4px]">
              <img src="/logo.png" alt="Orplex Tech" className="w-full h-full object-cover" />
            </div>
            <h1 className="text-[24px] font-semibold leading-[1.2] text-[#1a1c1d]">
              Authenticate Sequence
            </h1>
            <p className="text-[#5f5e5e] text-[14px] leading-[1.5] font-['JetBrains_Mono',monospace]">
              Secure access to Orplex core.
            </p>
          </div>

          {/* Desktop Header */}
          <div className="hidden md:block">
            <h2 className="text-[32px] font-semibold leading-[1.2] text-[#1a1c1d]">
              Authenticate Sequence
            </h2>
            <p className="text-[14px] leading-[1.5] text-[#5a4136] mt-[4px] font-['JetBrains_Mono',monospace]">
              Secure access to Orplex Tech core.
            </p>
          </div>

          {/* Error Message */}
          {error && (
            <div className="bg-[#ffdad6] border border-[#ba1a1a] text-[#93000a] px-4 py-3 rounded text-[14px] font-['JetBrains_Mono',monospace]">
              {error}
            </div>
          )}

          {/* Security Notice */}
          <div className="bg-[#FFF7ED] border border-[#ff6b00]/30 rounded-lg p-4">
            <p className="text-[12px] text-[#a04100] font-['JetBrains_Mono',monospace]">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{verticalAlign: "middle", marginRight: "4px"}}><rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0110 0v4" /></svg> <strong>OAuth Only</strong> — For your security, authentication is handled exclusively through trusted providers (Google, GitHub). No passwords are stored.
            </p>
          </div>

          {/* OAuth Buttons */}
          <div className="flex flex-col gap-4">
            {hasGoogle && (
              <button
                onClick={() => handleOAuth("google")}
                disabled={loading}
                className="w-full bg-white border-2 border-[#E4E4E7] hover:border-[#ff6b00] hover:bg-[#FFF7ED] text-[#1a1c1d] text-[12px] font-bold font-['JetBrains_Mono',monospace] py-4 rounded-lg transition-colors transition-border-color flex items-center justify-center gap-3 disabled:opacity-50"
              >
                <svg className="w-5 h-5" viewBox="0 0 24 24">
                  <path
                    d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                    fill="#4285F4"
                  />
                  <path
                    d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                    fill="#34A853"
                  />
                  <path
                    d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                    fill="#FBBC05"
                  />
                  <path
                    d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                    fill="#EA4335"
                  />
                </svg>
                {loading ? "Redirecting…" : "Continue with Google"}
              </button>
            )}

            {hasGitHub && (
              <button
                onClick={() => handleOAuth("github")}
                disabled={loading}
                className="w-full bg-[#24292f] hover:bg-[#1a1e22] text-white text-[12px] font-bold font-['JetBrains_Mono',monospace] py-4 rounded-lg transition-colors transition-border-color flex items-center justify-center gap-3 disabled:opacity-50"
              >
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
                </svg>
                {loading ? "Redirecting…" : "Continue with GitHub"}
              </button>
            )}
          </div>

          {/* Footer */}
          <p className="text-center text-[11px] text-[#5f5e5e] font-['JetBrains_Mono',monospace] mt-[16px]">
            By continuing, you agree to Orplex Tech&apos;s{" "}
            <a className="text-[#a04100] hover:text-[#dd8339] transition-colors" href="#">
              Terms
            </a>{" "}
            and{" "}
            <a className="text-[#a04100] hover:text-[#dd8339] transition-colors" href="#">
              Privacy Policy
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}