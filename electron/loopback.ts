// loopback.ts — how the desktop app addresses its own local server.
//
// The Next.js server is spawned with HOSTNAME=127.0.0.1, i.e. it listens on
// the IPv4 loopback only. "localhost" is NOT a safe alias for it: on Windows
// it resolves to ::1 (IPv6) first, and a request that lands on ::1 never
// reaches the IPv4 listener. The readiness probe then timed out and the app
// showed "Server failed to start" while the server was up and answering on
// 127.0.0.1.
//
// So: always talk to the address we bind, and keep "localhost" only as a
// probe fallback for the rare case where something else serves the port.

export const LOOPBACK_HOST = "127.0.0.1";

/** The URL of the app's own server on a given port. */
export function loopbackUrl(port: number): string {
  return `http://${LOOPBACK_HOST}:${port}`;
}

/**
 * URLs to probe for a server on `port`, in order: the address we bind first,
 * "localhost" as a fallback.
 */
export function loopbackProbeUrls(port: number): string[] {
  return [loopbackUrl(port), `http://localhost:${port}`];
}
