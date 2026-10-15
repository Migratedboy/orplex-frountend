// Client half of the LOCAL attachment store.
//
// Chat images are written to the user's own disk (<workspace>/.orplex/
// attachments) via the local-only /api/attachments route — never to Postgres.
// The message body keeps only an `attachment:<id><ext>` reference, so the
// saved conversation stays text-only and small.
//
// The in-memory message still shows the image immediately because the returned
// local URL replaces the data URL in `Message.images`.

/** Shape returned by POST /api/attachments. */
export interface StoredAttachment {
  id: string;
  filename: string;
  bytes: number;
  url: string;
}

export interface UploadableImage {
  name: string;
  dataUrl: string;
  size: number;
}

export interface StoredImage {
  name: string;
  /** Local URL for rendering, e.g. /api/attachments/<id>.png */
  dataUrl: string;
  size: number;
  /** `attachment:<id><ext>` reference persisted in the message body. */
  ref: string;
}

/**
 * Upload one image to local disk. Returns null on failure so a storage problem
 * degrades to "this image will not survive a reload" rather than breaking the
 * send — the model still receives the inline data URL either way.
 */
export async function uploadImage(dataUrl: string): Promise<StoredAttachment | null> {
  try {
    const res = await fetch("/api/attachments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataUrl }),
    });
    if (!res.ok) return null;
    return (await res.json()) as StoredAttachment;
  } catch {
    return null;
  }
}

/**
 * Persist every attached image locally, in parallel. Images that fail to store
 * are dropped from the returned list; the caller keeps sending their inline
 * data URLs to the model regardless.
 */
export async function persistImages(
  images: UploadableImage[],
): Promise<StoredImage[]> {
  const results = await Promise.all(
    images.map(async (img) => {
      const stored = await uploadImage(img.dataUrl);
      if (!stored) return null;
      const ext = stored.filename.slice(stored.id.length) || "";
      return {
        name: img.name,
        dataUrl: stored.url,
        size: img.size || stored.bytes,
        ref: `attachment:${stored.id}${ext}`,
      } satisfies StoredImage;
    }),
  );
  return results.filter((r): r is StoredImage => r !== null);
}

/** `attachment:<id><ext>` → the local URL to render. */
export function refToUrl(ref: string): string | null {
  const m = /^attachment:([a-f0-9]{32})(\.[a-z0-9]{2,5})$/.exec(ref.trim());
  return m ? `/api/attachments/${m[1]}${m[2]}` : null;
}

/** All attachment references embedded in a message body, in order. */
export function refsInContent(content: string): string[] {
  const out: string[] = [];
  const re = /attachment:[a-f0-9]{32}\.[a-z0-9]{2,5}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) out.push(m[0]);
  return out;
}

/** Append the refs to the message body so a reload can restore the images. */
export function contentWithRefs(content: string, refs: string[]): string {
  if (refs.length === 0) return content;
  const block = refs.map((r) => `![attachment](${r})`).join("\n");
  return content.trim() ? `${content}\n\n${block}` : block;
}
