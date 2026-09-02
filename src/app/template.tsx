// template.tsx — Re-mounts on navigation (unlike layout which persists).
// This wrapper div gets a fresh mount on each route change, triggering the
// CSS fade-in animation defined in globals.css (.page-transition).
// No JS animation library needed — pure CSS, zero overhead.

export default function Template({ children }: { children: React.ReactNode }) {
  return <div className="page-transition">{children}</div>;
}
