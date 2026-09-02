/**
 * Lightweight CSS geometric spinner used by route-level loading states
 * (settings, packages). No WebGL — pure CSS, matches the 3D loader's
 * orange/amber brand palette.
 */
export default function BrandSpinner({ size = 40 }: { size?: number }) {
  return (
    <span className="brand-spinner" style={{ width: size, height: size }} role="status" aria-label="Loading">
      <span className="brand-spinner-ring brand-spinner-ring-a" aria-hidden="true" />
      <span className="brand-spinner-ring brand-spinner-ring-b" aria-hidden="true" />
      <span className="brand-spinner-core" aria-hidden="true" />
    </span>
  );
}