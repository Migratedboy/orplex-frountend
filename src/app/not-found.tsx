import Link from "next/link";

export default function NotFound() {
  return (
    <div className="app-root">
      <div className="error-page">
        <div className="error-page-card">
          <div className="error-page-icon">404</div>
          <h1 className="error-page-title">Page not found</h1>
          <p className="error-page-message">The page you&apos;re looking for doesn&apos;t exist or has been moved.</p>
          <Link href="/" className="error-page-retry" style={{ textDecoration: "none" }}>
            Go to Home
          </Link>
        </div>
      </div>
    </div>
  );
}
