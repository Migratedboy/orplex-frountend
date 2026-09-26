// favicon.ico route — legacy browsers request /favicon.ico by convention;
// the app-wide icon otherwise lives at /icon.png (src/app/icon.png, picked up
// by the App Router's file-convention metadata). Same image, correct type.
// (A hand-wrapped ICO file in src/app would go through Next's static image
// decoder, which rejects PNG-wrapped-ICO — hence serving the PNG directly.)
export const dynamic = "force-static";

export async function GET() {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const png = await readFile(join(process.cwd(), "public", "logo.png"));
  return new Response(new Uint8Array(png), {
    headers: {
      "Content-Type": "image/x-icon",
      "Cache-Control": "public, max-age=86400",
    },
  });
}
