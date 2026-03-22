import type { SupabaseClient } from "@supabase/supabase-js";

/** Parse `/storage/v1/object/public/{bucket}/{path}` from a Supabase project URL */
export function parseSupabasePublicStorageUrl(url: string): { bucket: string; path: string } | null {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\/storage\/v1\/object\/public\/([^/]+)\/(.+)$/);
    if (!m) return null;
    return { bucket: m[1], path: decodeURIComponent(m[2]) };
  } catch {
    return null;
  }
}

export async function getSignedUrlForPublicStorageUrl(
  supabase: SupabaseClient,
  publicUrl: string,
  expiresSec = 3600
): Promise<string | null> {
  const p = parseSupabasePublicStorageUrl(publicUrl);
  if (!p) return null;
  const { data, error } = await supabase.storage.from(p.bucket).createSignedUrl(p.path, expiresSec);
  if (error || !data?.signedUrl) return null;
  return data.signedUrl;
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const chunk = 8192;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.slice(i, i + chunk));
  }
  return btoa(binary);
}

function mimeFromUrlOrType(url: string, contentType: string | null): string {
  const ct = contentType?.split(";")[0]?.trim();
  if (ct && ct.startsWith("image/")) return ct;
  const lower = url.split("?")[0].toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  return "image/jpeg";
}

/**
 * Load image bytes for Gemini: data URLs, authenticated Supabase Storage download,
 * then plain fetch (CDN / public URLs).
 */
export async function loadImageForGemini(
  url: string,
  supabase?: SupabaseClient
): Promise<{ base64: string; mime: string }> {
  if (url.startsWith("data:")) {
    const comma = url.indexOf(",");
    const header = url.slice(5, comma);
    const mime = header.split(";")[0].trim() || "image/jpeg";
    const b64 = url.slice(comma + 1);
    return { base64: b64, mime: mime.startsWith("image/") ? mime : "image/jpeg" };
  }

  const parsed = supabase ? parseSupabasePublicStorageUrl(url) : null;

  if (supabase && parsed) {
    const { data: blob, error } = await supabase.storage.from(parsed.bucket).download(parsed.path);
    if (!error && blob) {
      const buf = await blob.arrayBuffer();
      const mime =
        blob.type && blob.type.startsWith("image/") ? blob.type : mimeFromUrlOrType(url, null);
      return { base64: arrayBufferToBase64(buf), mime };
    }
    const { data: signed, error: signErr } = await supabase.storage.from(parsed.bucket).createSignedUrl(parsed.path, 3600);
    if (!signErr && signed?.signedUrl) {
      const res = await fetch(signed.signedUrl);
      if (res.ok) {
        const buf = await res.arrayBuffer();
        return {
          base64: arrayBufferToBase64(buf),
          mime: mimeFromUrlOrType(url, res.headers.get("content-type"))
        };
      }
    }
  }

  const res = await fetch(url, { mode: "cors" });
  if (!res.ok) {
    throw new Error(`Failed to fetch image: ${res.status}`);
  }
  const buf = await res.arrayBuffer();
  return {
    base64: arrayBufferToBase64(buf),
    mime: mimeFromUrlOrType(url, res.headers.get("content-type"))
  };
}

/** Use in <img src> when bucket may be private */
export async function getDisplayableImageUrl(supabase: SupabaseClient, url: string): Promise<string> {
  if (!url || url.startsWith("data:")) return url;
  const signed = await getSignedUrlForPublicStorageUrl(supabase, url, 3600);
  return signed || url;
}
