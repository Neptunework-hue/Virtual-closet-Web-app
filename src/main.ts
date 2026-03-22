import "./styles.css";
import { createClient } from "@supabase/supabase-js";
import { requestTryOn } from "./gemini";
import { getDisplayableImageUrl } from "./supabaseImage";

type Tab = "Explore" | "Setup" | "TryOn" | "Closet";
type TryOnMode = "photo" | "avatar";
type AuthMode = "signin" | "signup";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  document.getElementById("app")!.innerHTML = "<div style='padding:20px'>Missing Supabase env vars.</div>";
  throw new Error("Missing Supabase env vars");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const app = document.getElementById("app")!;

let activeTab: Tab = "Explore";
let userId: string | null = null;
let authMode: AuthMode = "signin";
let exploreSearch = "";
let exploreCategory = "all";
let exploreSort: "newest" | "likes" = "newest";
let closetSection: "all" | "saved" | "tryon" | "uploaded" = "all";
let generating = false;
/** Matches mobile: separate Photo setup vs Avatar setup screens */
let setupSegment: "photo" | "avatar" = (sessionStorage.getItem("vc_setup_segment") as "photo" | "avatar") || "photo";

type PendingSingleTryOn = { outfitId: string | null; title: string; desc: string; image: string };
type PendingMultiTryOn = { outfits: Array<{ url: string; title: string; description: string }> };
let pendingTryOn: { kind: "single"; data: PendingSingleTryOn } | { kind: "multi"; data: PendingMultiTryOn } | null = null;

type ExploreQuickContext = { outfitId: string; imageUrl: string; title: string; desc: string; saved: boolean };
let exploreQuickContext: ExploreQuickContext | null = null;

function syncExploreQuickOverlayUI() {
  const ctx = exploreQuickContext;
  const sub = document.getElementById("exploreQuickSubtitle");
  const saveBtn = document.getElementById("exploreQuickSave");
  const unsaveBtn = document.getElementById("exploreQuickUnsave");
  if (!ctx) {
    if (sub) sub.textContent = "";
    if (saveBtn) saveBtn.style.display = "none";
    if (unsaveBtn) unsaveBtn.style.display = "none";
    return;
  }
  if (sub) sub.textContent = ctx.title;
  if (saveBtn) saveBtn.style.display = ctx.saved ? "none" : "block";
  if (unsaveBtn) unsaveBtn.style.display = ctx.saved ? "block" : "none";
}

function showExploreQuickOverlay() {
  const el = document.getElementById("exploreQuickOverlay");
  if (!el || !exploreQuickContext) return;
  syncExploreQuickOverlayUI();
  el.style.display = "flex";
  el.setAttribute("aria-hidden", "false");
}

function hideExploreQuickOverlay() {
  const el = document.getElementById("exploreQuickOverlay");
  if (el) {
    el.style.display = "none";
    el.setAttribute("aria-hidden", "true");
  }
  exploreQuickContext = null;
}

function getManualPrefColumn(tab: Tab) {
  return { Explore: "show_explore_popup", Setup: "show_explore_popup", TryOn: "show_tryon_popup", Closet: "show_closet_popup" }[tab];
}

async function shouldShowManual(tab: Tab): Promise<boolean> {
  if (tab === "Setup") return false;
  if (!userId) return false;
  if (localStorage.getItem(`manual:${tab}:hidden`) === "1") return false;
  const col = getManualPrefColumn(tab);
  const { data } = await supabase.from("profiles").select(col).eq("id", userId).single();
  const row = (data || {}) as Record<string, unknown>;
  return row[col] !== false;
}

async function hideManualPermanently(tab: Tab) {
  if (!userId) return;
  localStorage.setItem(`manual:${tab}:hidden`, "1");
  const col = getManualPrefColumn(tab);
  await supabase.from("profiles").update({ [col]: false }).eq("id", userId);
}

function manualContent(tab: Tab) {
  return {
    Explore: { title: "Meet Loki - Explore Guide", subtitle: "Discover, like, save, and try on outfits.", tips: ["Use the floating + button to post an outfit.", "Tap any outfit image to view full screen.", "Use … for Save / Unsave and Try On (Pinterest-style cards)."] },
    TryOn: { title: "Meet Loki - Try-On Guide", subtitle: "Generate and manage your AI try-ons.", tips: ["Choose full body or avatar mode when you tap Try On.", "Multi-item: select items in Closet, then pick a mode.", "Tap a result image to view it full screen."] },
    Closet: { title: "Meet Loki - Closet Guide", subtitle: "Saved, uploaded, and generated outfits.", tips: ["Tap images to view full screen.", "Select 1+ items → Try On Selected → pick full body or avatar mode.", "Your Explore uploads live under Uploaded — use Delete post to remove them from the feed."] },
    Setup: { title: "Meet Loki - Photos", subtitle: "Upload reference images for AI try-on.", tips: ["Full-body shot for photo mode.", "Clear face shot for avatar mode.", "Pick which mode is active for each generation."] }
  }[tab];
}

function shell(content: string, showManualPopup: boolean) {
  const m = manualContent(activeTab);
  app.innerHTML = `
  <main class="app-shell">
    <header class="card header">
      <h2>Virtual Closet</h2>
      <button id="signOutBtn" class="btn ghost">Sign Out</button>
    </header>
    <section class="card screen">${content}</section>
    <nav class="card tabbar">
      ${(["Explore", "Setup", "TryOn", "Closet"] as Tab[]).map((t) => `<button class="${activeTab === t ? "active" : ""}" data-tab="${t}">${t}</button>`).join("")}
    </nav>
  </main>
  ${showManualPopup ? `<div id="manualOverlay" class="overlay"><div class="modal card"><h3>${m.title}</h3><p class="muted">${m.subtitle}</p><ul>${m.tips.map((t) => `<li>${t}</li>`).join("")}</ul><div class="row"><button id="manualDontShow" class="btn ghost">Don't show again</button><button id="manualClose" class="btn primary">Let's go</button></div></div></div>` : ""}
  <div id="tryonModeOverlay" class="overlay tryon-mode-overlay" style="display:none" aria-hidden="true">
    <div class="modal card tryon-mode-modal">
      <h3 id="tryonModeTitle">Choose try-on mode</h3>
      <p id="tryonModeSubtitle" class="muted">Pick which reference photo to use for this generation.</p>
      <div class="tryon-mode-actions">
        <button type="button" id="tryonModeFullBody" class="btn setup-complete tryon-mode-btn">Full body mode</button>
        <p class="muted tryon-mode-hint">Uses your <strong>full-body</strong> photo from Setup.</p>
        <button type="button" id="tryonModeAvatar" class="btn ios-primary tryon-mode-btn">Avatar mode</button>
        <p class="muted tryon-mode-hint">Uses your <strong>face</strong> photo from Setup (AI renders full body).</p>
        <button type="button" id="tryonModeCancel" class="btn setup-skip tryon-mode-btn">Cancel</button>
      </div>
    </div>
  </div>
  <div id="imageLightbox" class="overlay lightbox-viewer" style="display:none" aria-hidden="true">
    <button type="button" id="lightboxClose" class="lightbox-close" aria-label="Close">×</button>
    <img id="lightboxImg" class="lightbox-img-el" alt="Full size" />
  </div>
  `;
}

async function renderAuth() {
  app.innerHTML = `<main class="app-shell" style="max-width:480px"><section class="card screen stack"><h2>${authMode === "signup" ? "Create account" : "Welcome back"}</h2><label>Email<input id="email" type="email" /></label><label>Password<input id="password" type="password" /></label><label style="display:${authMode === "signup" ? "block" : "none"}">Confirm Password<input id="confirmPassword" type="password" /></label><button id="authSubmit" class="btn primary">${authMode === "signup" ? "Sign Up" : "Sign In"}</button><div class="row"><button id="toggleMode" class="btn ghost">${authMode === "signup" ? "Have account? Sign In" : "No account? Sign Up"}</button><button id="resetPassword" class="btn ghost">Forgot Password</button></div><button id="resendEmail" class="btn ghost">Resend Verification Email</button></section></main>`;

  document.getElementById("toggleMode")!.onclick = async () => { authMode = authMode === "signin" ? "signup" : "signin"; await renderAuth(); };
  document.getElementById("authSubmit")!.onclick = async () => {
    const email = (document.getElementById("email") as HTMLInputElement).value.trim();
    const password = (document.getElementById("password") as HTMLInputElement).value;
    const confirmPassword = (document.getElementById("confirmPassword") as HTMLInputElement | null)?.value ?? "";
    if (!email || !password) return alert("Fill email and password.");
    if (authMode === "signup" && password !== confirmPassword) return alert("Passwords do not match.");
    if (authMode === "signup") {
      const { error } = await supabase.auth.signUp({ email, password });
      if (error) alert(error.message); else alert("Sign up successful. Verify email if required.");
      return;
    }
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return alert(error.message);
    await bootstrap();
  };
  document.getElementById("resetPassword")!.onclick = async () => {
    const email = (document.getElementById("email") as HTMLInputElement).value.trim();
    if (!email) return alert("Enter email first.");
    const { error } = await supabase.auth.resetPasswordForEmail(email);
    if (error) alert(error.message); else alert("Password reset email sent.");
  };
  document.getElementById("resendEmail")!.onclick = async () => {
    const email = (document.getElementById("email") as HTMLInputElement).value.trim();
    if (!email) return alert("Enter email first.");
    const { error } = await supabase.auth.resend({ type: "signup", email });
    if (error) alert(error.message); else alert("Verification email sent.");
  };
}


async function ensureProfile(email?: string | null) {
  if (!userId) return;
  const { data } = await supabase.from("profiles").select("id").eq("id", userId).maybeSingle();
  if (data?.id) return;
  await supabase.from("profiles").insert({
    id: userId,
    email: email ?? null,
    display_name: email?.split("@")[0] ?? "User",
    profile_mode: "photo"
  });
}

/** Upload user-posted outfit image to Storage (same bucket as mobile). */
async function uploadOutfitImageFile(file: File): Promise<string> {
  const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
  const safe = /^(jpe?g|png|webp|gif)$/.test(ext) ? ext : "jpg";
  const path = `${userId}/outfit_${Date.now()}.${safe}`;
  const mime = file.type || "image/jpeg";
  const { error } = await supabase.storage.from("outfits").upload(path, file, { contentType: mime, upsert: true });
  if (error) throw error;
  const { data } = supabase.storage.from("outfits").getPublicUrl(path);
  if (!data?.publicUrl) throw new Error("Could not get public URL for outfit image.");
  return data.publicUrl;
}

async function publishOutfitPost(title: string, description: string, category: string, file: File) {
  if (!title.trim()) throw new Error("Add a title for your outfit.");
  const imageUrl = await uploadOutfitImageFile(file);
  const { data: outfit, error: outfitErr } = await supabase
    .from("outfits")
    .insert({
      title: title.trim(),
      vendor: "Community",
      description: description.trim() || null,
      image_url: imageUrl,
      tags: [],
      discount: 0,
      category: category.trim() || null,
      uploaded_by: userId
    })
    .select("id")
    .single();
  if (outfitErr) throw outfitErr;
  const { error: feedErr } = await supabase.from("explore_feed").insert({ outfit_id: outfit.id });
  if (feedErr) throw feedErr;
  const { error: closetErr } = await supabase.from("closet").insert({
    user_id: userId,
    outfit_id: outfit.id,
    metadata: { is_uploaded_outfit: true, uploaded_at: new Date().toISOString() }
  });
  if (closetErr) throw closetErr;
}

/** Remove user's uploaded outfit from Explore, closet references, likes, and outfits (matches mobile flow). */
async function deleteUploadedOutfitPost(outfitId: string) {
  if (!userId) throw new Error("Sign in required.");
  const { data: outfit, error: fetchErr } = await supabase
    .from("outfits")
    .select("id, uploaded_by")
    .eq("id", outfitId)
    .single();
  if (fetchErr || !outfit) throw new Error("Outfit not found.");
  if (String((outfit as { uploaded_by?: string }).uploaded_by) !== String(userId)) {
    throw new Error("You can only delete outfits you uploaded.");
  }

  const { error: likesErr } = await supabase.from("outfit_likes").delete().eq("outfit_id", outfitId);
  if (likesErr) throw likesErr;

  const { error: feedErr } = await supabase.from("explore_feed").delete().eq("outfit_id", outfitId);
  if (feedErr) throw feedErr;

  const { error: closetErr } = await supabase.from("closet").delete().eq("outfit_id", outfitId);
  if (closetErr) throw closetErr;

  const { error: delOutfitErr } = await supabase.from("outfits").delete().eq("id", outfitId).eq("uploaded_by", userId);
  if (delOutfitErr) throw delOutfitErr;
}

async function uploadReferenceImage(bucket: "full_bodies" | "avatars", file: File): Promise<string> {
  const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
  const safe = /^(jpe?g|png|webp|gif)$/.test(ext) ? ext : "jpg";
  const path = `${userId}/${Date.now()}.${safe}`;
  const mime = file.type || "image/jpeg";
  const { error } = await supabase.storage.from(bucket).upload(path, file, { contentType: mime, upsert: true });
  if (error) throw error;
  const { data } = supabase.storage.from(bucket).getPublicUrl(path);
  if (!data?.publicUrl) throw new Error("Could not get public URL for upload.");
  return data.publicUrl;
}

/** Person image for the mode chosen in the try-on popup (not profile_mode). */
async function getPersonUrlForTryOn(mode: TryOnMode): Promise<string> {
  const { data: profile, error } = await supabase.from("profiles").select("*").eq("id", userId).single();
  if (error || !profile) {
    throw new Error("Profile not found. Open the Setup tab to save your reference photos.");
  }
  if (mode === "avatar") {
    const personUrl = profile.face_image_url || profile.avatar_image_url;
    if (!personUrl) {
      throw new Error("Upload a face photo in the Setup tab to use avatar mode.");
    }
    return personUrl as string;
  }
  const personUrl = profile.full_body_image_url || profile.face_image_url || profile.avatar_image_url;
  if (!personUrl) {
    throw new Error("Upload a full-body photo in the Setup tab to use full body mode.");
  }
  return personUrl as string;
}

async function saveTryOnResult(imageDataUrl: string, sourceOutfitId: string | null, sourceTitle: string, tryonMode: TryOnMode) {
  const { error } = await supabase.from("closet").insert({
    user_id: userId,
    outfit_id: sourceOutfitId,
    tryon_image_url: imageDataUrl,
    metadata: {
      is_tryon_result: true,
      is_saved_outfit: false,
      tryon_mode: tryonMode,
      original_outfit_title: sourceTitle,
      generated_at: new Date().toISOString()
    }
  });
  if (error) throw error;
}

function showTryonModeModal() {
  const titleEl = document.getElementById("tryonModeTitle");
  const subEl = document.getElementById("tryonModeSubtitle");
  if (pendingTryOn?.kind === "multi") {
    const n = pendingTryOn.data.outfits.length;
    if (titleEl) titleEl.textContent = n > 1 ? "Multi-item try-on — choose mode" : "Try-on — choose mode";
    if (subEl) {
      subEl.textContent =
        n > 1
          ? "You’re combining several closet items into one look. Choose full body or avatar reference (same as single try-on)."
          : "Choose full body or avatar reference for the selected outfit.";
    }
  } else {
    if (titleEl) titleEl.textContent = "Choose try-on mode";
    if (subEl) subEl.textContent = "Pick which reference photo to use for this outfit.";
  }
  const el = document.getElementById("tryonModeOverlay");
  if (el) {
    el.style.display = "flex";
    el.setAttribute("aria-hidden", "false");
  }
}

function hideTryonModeModal() {
  const el = document.getElementById("tryonModeOverlay");
  if (el) {
    el.style.display = "none";
    el.setAttribute("aria-hidden", "true");
  }
}

function openImageLightbox(src: string) {
  const overlay = document.getElementById("imageLightbox");
  const img = document.getElementById("lightboxImg") as HTMLImageElement | null;
  if (!overlay || !img) return;
  img.src = src;
  overlay.style.display = "flex";
  overlay.setAttribute("aria-hidden", "false");
}

function closeImageLightbox() {
  const overlay = document.getElementById("imageLightbox");
  const img = document.getElementById("lightboxImg") as HTMLImageElement | null;
  if (overlay) {
    overlay.style.display = "none";
    overlay.setAttribute("aria-hidden", "true");
  }
  if (img) img.src = "";
}

function showOutfitPostModal() {
  const el = document.getElementById("outfitPostOverlay");
  if (el) {
    el.style.display = "flex";
    el.setAttribute("aria-hidden", "false");
  }
}

function hideOutfitPostModal() {
  const el = document.getElementById("outfitPostOverlay");
  if (el) {
    el.style.display = "none";
    el.setAttribute("aria-hidden", "true");
  }
}

async function runTryOnAfterModeChoice(mode: TryOnMode) {
  const p = pendingTryOn;
  pendingTryOn = null;
  if (!p) return;
  generating = true;
  await renderCurrent();
  try {
    const personUrl = await getPersonUrlForTryOn(mode);
    if (p.kind === "single") {
      const { outfitId, title, desc, image } = p.data;
      const result = await requestTryOn({
        user_id: userId!,
        mode,
        person_url: personUrl,
        outfit_url: image,
        outfitTitle: title,
        outfitDescription: desc,
        supabase
      });
      if (!result.success || !result.imageUrl) throw new Error(result.error || "No image generated.");
      await saveTryOnResult(result.imageUrl, outfitId, title, mode);
      alert("Try-on generated and saved.");
      activeTab = "TryOn";
    } else {
      const { outfits } = p.data;
      const result = await requestTryOn({
        user_id: userId!,
        mode,
        person_url: personUrl,
        outfit_url: outfits[0]?.url || "",
        outfitTitle: outfits[0]?.title || "Outfit",
        multipleOutfits: outfits.map((o) => ({ outfit_url: o.url, title: o.title, description: o.description })),
        supabase
      });
      if (!result.success || !result.imageUrl) throw new Error(result.error || "No image generated.");
      await saveTryOnResult(result.imageUrl, null, outfits.map((o) => o.title).join(", "), mode);
      alert(outfits.length > 1 ? "Multi-item try-on generated and saved." : "Try-on generated and saved.");
      activeTab = "TryOn";
    }
  } catch (e: any) {
    alert(e?.message || "Try-on failed");
  } finally {
    generating = false;
    await renderCurrent();
  }
}

async function renderSetup() {
  const { data: profile } = await supabase.from("profiles").select("*").eq("id", userId).maybeSingle();
  const fb = (profile?.full_body_image_url as string) || "";
  const face = (profile?.face_image_url || profile?.avatar_image_url || "") as string;
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const fbDisplay = fb ? esc(await getDisplayableImageUrl(supabase, fb)) : "";
  const faceDisplay = face ? esc(await getDisplayableImageUrl(supabase, face)) : "";
  const height = profile?.height_cm != null ? String(profile.height_cm) : "";
  const weight = profile?.weight_kg != null ? String(profile.weight_kg) : "";
  const bodyType = (profile?.body_type as string) || "";
  const seg = setupSegment;

  const segTabs = `<div class="setup-seg-wrap">
    <button type="button" class="setup-seg-btn ${seg === "photo" ? "active" : ""}" data-setup-seg="photo">Photo setup</button>
    <button type="button" class="setup-seg-btn ${seg === "avatar" ? "active" : ""}" data-setup-seg="avatar">Avatar setup</button>
  </div>`;

  const photoBlock = `
    <div class="setup-screen" style="display:${seg === "photo" ? "block" : "none"}">
      <h1 class="setup-title">Photo Setup</h1>
      <p class="setup-subtitle">Upload a full-body photo for the most realistic try-on experience</p>
      <div class="setup-instructions-card">
        <div class="setup-instructions-title">📸 Photo Guidelines</div>
        <ul class="setup-instructions-list">
          <li>Stand straight in front of a plain background</li>
          <li>Wear fitted clothing (avoid loose/baggy clothes)</li>
          <li>Ensure good lighting</li>
          <li>Include your full body from head to toe</li>
          <li>Face the camera directly</li>
        </ul>
      </div>
      <div class="setup-section card">
        <h2 class="setup-section-title">Upload Full-Body Photo</h2>
        <p class="setup-section-desc">Take a photo or choose from your library. We use it as the canvas for try-on.</p>
        ${fbDisplay ? `<img class="preview-thumb" src="${fbDisplay}" alt="Full body preview" />` : ""}
        <label class="btn ios-primary setup-upload-btn">
          Upload your full-body photo
          <input id="fullBodyFile" type="file" accept="image/*" hidden />
        </label>
      </div>
      <div class="setup-actions">
        <button type="button" id="setupSkipPhoto" class="btn setup-skip">Skip Setup</button>
        <button type="button" id="setupCompletePhoto" class="btn setup-complete">Complete Setup</button>
      </div>
    </div>`;

  const avatarBlock = `
    <div class="setup-screen" style="display:${seg === "avatar" ? "block" : "none"}">
      <h1 class="setup-title">Avatar Setup</h1>
      <p class="setup-subtitle">Create your virtual avatar by uploading a face photo and optional body details</p>
      <div class="setup-instructions-card setup-instructions-avatar">
        <div class="setup-instructions-title">✨ Face photo tips</div>
        <ul class="setup-instructions-list">
          <li>Clear, front-facing face</li>
          <li>Neutral expression, good lighting</li>
          <li>Remove sunglasses / heavy shadows</li>
        </ul>
      </div>
      <div class="setup-section card">
        <h2 class="setup-section-title">1. Upload Face Photo</h2>
        <p class="setup-section-desc">Take a clear photo of your face or choose from your library</p>
        ${faceDisplay ? `<img class="preview-thumb preview-face" src="${faceDisplay}" alt="Face preview" />` : ""}
        <label class="btn ios-primary setup-upload-btn">
          Upload your face photo
          <input id="faceFile" type="file" accept="image/*" hidden />
        </label>
      </div>
      <div class="setup-section card">
        <h2 class="setup-section-title">2. Body Details (Optional)</h2>
        <p class="setup-section-desc">Helps the AI match proportions (same fields as the mobile app)</p>
        <label class="setup-field">Height (cm)<input id="avatarHeight" type="number" inputmode="decimal" placeholder="e.g. 175" value="${esc(height)}" /></label>
        <label class="setup-field">Weight (kg)<input id="avatarWeight" type="number" inputmode="decimal" placeholder="e.g. 70" value="${esc(weight)}" /></label>
        <label class="setup-field">Body type<input id="avatarBodyType" type="text" placeholder="slim, athletic, curvy…" value="${esc(bodyType)}" /></label>
        <button type="button" id="saveAvatarBody" class="btn ghost" style="margin-top:8px">Save body details</button>
      </div>
      <div class="setup-actions">
        <button type="button" id="setupSkipAvatar" class="btn setup-skip">Skip Setup</button>
        <button type="button" id="setupCompleteAvatar" class="btn setup-complete">Complete Setup</button>
      </div>
    </div>`;

  const footer = `<p class="setup-footer muted">Each try-on asks which mode to use. Storage buckets: <code>full_bodies</code>, <code>avatars</code>.</p>`;

  return `<div class="stack setup-page">${segTabs}${photoBlock}${avatarBlock}${footer}</div>`;
}

function escAttr(s: string) {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function exploreSearchMatches(item: any, q: string): boolean {
  if (!q) return true;
  const n = q.toLowerCase();
  const title = String(item.title || "").toLowerCase();
  const desc = String(item.description || "").toLowerCase();
  const cat = String(item.category || "").toLowerCase();
  return title.includes(n) || desc.includes(n) || cat.includes(n);
}

async function renderExplore() {
  const { data, error } = await supabase.from("explore_feed_with_likes").select("*").limit(120);
  if (error) return `<p>${error.message}</p>`;

  const savedExploreOutfitIds = new Set<string>();
  if (userId) {
    const { data: savedRows } = await supabase
      .from("closet")
      .select("outfit_id")
      .eq("user_id", userId)
      .is("tryon_image_url", null);
    for (const r of savedRows || []) {
      const oid = (r as { outfit_id?: string }).outfit_id;
      if (oid) savedExploreOutfitIds.add(String(oid));
    }
  }

  const categories = Array.from(new Set((data || []).map((i: any) => i.category).filter(Boolean))).sort();
  const q = exploreSearch.trim();
  const filtered = (data || [])
    .filter(
      (i: any) =>
        (exploreCategory === "all" || String(i.category || "").toLowerCase() === exploreCategory.toLowerCase()) &&
        exploreSearchMatches(i, q)
    )
    .sort((a: any, b: any) => (exploreSort === "likes" ? (b.like_count || 0) - (a.like_count || 0) : new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime()));
  const outfitFabAndModal = `<button type="button" id="outfitFab" class="outfit-fab" title="Post an outfit" aria-label="Post an outfit"><span class="outfit-fab-icon" aria-hidden="true">+</span></button>
  <div id="outfitPostOverlay" class="overlay outfit-post-overlay" style="display:none" aria-hidden="true">
    <div class="modal card outfit-post-modal" role="dialog" aria-labelledby="outfitPostModalTitle">
      <h4 id="outfitPostModalTitle" class="outfit-post-modal-title">Post an outfit</h4>
      <p class="muted outfit-post-modal-desc">Photo + details, then publish to Explore (and your Closet → Uploaded).</p>
      <label class="explore-post-field">Photo (required)<input id="outfitPostFile" type="file" accept="image/*" /></label>
      <label class="explore-post-field">Title (required)<input id="outfitPostTitle" type="text" placeholder="e.g. Summer linen set" /></label>
      <label class="explore-post-field">Description<textarea id="outfitPostDesc" rows="2" placeholder="Optional"></textarea></label>
      <label class="explore-post-field">Category<input id="outfitPostCategory" type="text" placeholder="e.g. Casual, Streetwear" /></label>
      <div class="outfit-post-actions row" style="margin-top:14px;flex-wrap:nowrap">
        <button type="button" id="outfitPostCancel" class="btn setup-skip" style="flex:1">Cancel</button>
        <button type="button" id="outfitPostSubmit" class="btn primary" style="flex:1">Publish</button>
      </div>
    </div>
  </div>`;

  const exploreQuickOverlayHtml = `<div id="exploreQuickOverlay" class="overlay explore-quick-overlay" style="display:none" aria-hidden="true">
    <div class="modal card explore-quick-modal" role="dialog" aria-labelledby="exploreQuickHeading" aria-modal="true">
      <h3 id="exploreQuickHeading" class="explore-quick-heading">Quick actions</h3>
      <p id="exploreQuickSubtitle" class="muted explore-quick-subtitle"></p>
      <div class="explore-quick-btns">
        <button type="button" id="exploreQuickSave" class="btn primary explore-quick-btn">Save to closet</button>
        <button type="button" id="exploreQuickUnsave" class="btn ghost explore-quick-btn">Remove from closet</button>
        <button type="button" id="exploreQuickTryOn" class="btn ios-primary explore-quick-btn">Try On</button>
        <button type="button" id="exploreQuickClose" class="btn setup-skip explore-quick-btn">Close</button>
      </div>
    </div>
  </div>`;

  const pinsHtml = filtered
    .map((item: any) => {
      const imgUrl = item.image_url || "";
      const title = item.title || "Untitled";
      const tryLabel = generating ? "Generating…" : "Try On";
      const tryData = `data-id="${item.outfit_id}" data-title="${(item.title || "Outfit").replace(/"/g, "&quot;")}" data-desc="${(item.description || "").replace(/"/g, "&quot;")}" data-image="${escAttr(imgUrl)}"`;
      const likeCount = Number(item.like_count) || 0;
      const isSaved = savedExploreOutfitIds.has(String(item.outfit_id));
      const heartSvg = item.has_liked
        ? `<svg class="explore-pin-heart-svg" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="#e74c3c" d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`
        : `<svg class="explore-pin-heart-svg" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="none" stroke="#333" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`;
      return `<article class="explore-pin">
        <div class="explore-pin-media">
          <img class="explore-pin-img zoomable-img" tabindex="0" loading="lazy" src="${escAttr(imgUrl)}" alt="${escAttr(title)}" title="Tap for full size" />
          <button type="button" class="explore-pin-like like-btn" data-id="${item.outfit_id}" data-liked="${item.has_liked ? 1 : 0}" aria-label="${item.has_liked ? "Unlike outfit" : "Like outfit"}">
            ${heartSvg}
            <span class="explore-pin-like-count" aria-hidden="true">${likeCount}</span>
          </button>
          <div class="explore-pin-hover" aria-hidden="true">
            <button type="button" class="explore-pin-try-chip tryon-single" ${tryData}>${tryLabel}</button>
          </div>
        </div>
        <div class="explore-pin-body">
          <div class="explore-pin-title-row">
            <h3 class="explore-pin-title">${escAttr(title)}</h3>
            <button type="button" class="explore-quick-trigger" aria-label="More options"
              data-outfit-id="${escAttr(String(item.outfit_id))}"
              data-saved="${isSaved ? "1" : "0"}"
              data-image="${escAttr(imgUrl)}"
              data-title="${escAttr(title)}"
              data-desc="${escAttr(String(item.description || ""))}">
              <span class="explore-pin-dots-text">...</span>
            </button>
          </div>
        </div>
      </article>`;
    })
    .join("");

  const emptyHtml =
    filtered.length === 0
      ? `<div class="explore-empty card"><p class="explore-empty-title">No pins yet</p><p class="muted explore-empty-desc">Try a different search, pick <strong>All</strong> categories, or tap <strong>+</strong> to post your first outfit.</p></div>`
      : "";

  return `<div class="stack explore-with-fab explore-pinterest-root">
    <header class="explore-pinterest-header">
      <div class="explore-pinterest-brand-row">
        <span class="explore-pinterest-label">Explore</span>
        <span class="explore-pinterest-sub muted">Discover &amp; try on looks</span>
      </div>
      <div class="explore-search-wrap">
        <span class="explore-search-icon" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
        </span>
        <input id="exploreSearch" class="explore-search-input" type="search" enterkeyhint="search" value="${escAttr(exploreSearch)}" placeholder="Search outfits, styles, categories…" autocomplete="off" />
      </div>
      <div class="explore-filter-bar">
        <select id="exploreCategory" class="explore-filter-select" aria-label="Category">
          <option value="all">All categories</option>
          ${categories.map((c) => `<option value="${escAttr(String(c))}" ${exploreCategory === c ? "selected" : ""}>${escAttr(String(c))}</option>`).join("")}
        </select>
        <select id="exploreSort" class="explore-filter-select" aria-label="Sort">
          <option value="newest" ${exploreSort === "newest" ? "selected" : ""}>Newest</option>
          <option value="likes" ${exploreSort === "likes" ? "selected" : ""}>Most liked</option>
        </select>
        <button type="button" id="applyExploreFilters" class="explore-filter-apply btn ghost">Apply</button>
      </div>
      <p class="explore-fab-hint muted">Tap <strong>+</strong> to post an outfit — same as the mobile app.</p>
    </header>
    <div class="explore-masonry">${pinsHtml}</div>
    ${emptyHtml}
    ${exploreQuickOverlayHtml}
    ${outfitFabAndModal}
  </div>`;
}

async function renderTryOn() {
  const { data: tryons, error } = await supabase
    .from("closet")
    .select("*")
    .eq("user_id", userId)
    .not("tryon_image_url", "is", null)
    .order("created_at", { ascending: false })
    .limit(40);
  if (error) return `<p>${error.message}</p>`;
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  return `<div class="stack"><h3>Try On</h3><p class="muted">Upload reference photos in the <strong>Setup</strong> tab. <strong>Tap</strong> a result to view full size.</p><h4>Generated Results</h4><div class="grid">${(tryons || []).map((t: any) => {
    const src = t.tryon_image_url || "";
    return `<article class="item card tryon-result-card" style="padding:8px"><img class="tryon-result-thumb zoomable-img" tabindex="0" src="${esc(src)}" alt="Try-on result — tap to enlarge" title="Tap for full size" /><div class="muted">${new Date(t.created_at).toLocaleString()}</div><div class="row"><button class="btn danger delete-tryon" data-id="${t.id}">Delete</button><button class="btn ghost save-tryon" data-id="${t.id}">Save</button></div></article>`;
  }).join("")}</div></div>`;
}

async function renderCloset() {
  const { data, error } = await supabase
    .from("closet")
    .select("*, outfits(image_url, title)")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(80);
  if (error) return `<p>${error.message}</p>`;
  const items = (data || []).filter((item: any) => {
    const m = item?.metadata || {};
    const isTryOn = !!item.tryon_image_url || m.is_tryon_result === true;
    const isUploaded = m.is_uploaded_outfit === true;
    if (closetSection === "tryon") return isTryOn;
    if (closetSection === "uploaded") return isUploaded;
    if (closetSection === "saved") return !isTryOn && !isUploaded;
    return true;
  });
  return `<div class="stack"><h3>Closet</h3><div class="row"><button class="btn ${closetSection === "all" ? "primary" : "ghost"} closet-tab" data-section="all">All</button><button class="btn ${closetSection === "saved" ? "primary" : "ghost"} closet-tab" data-section="saved">Saved</button><button class="btn ${closetSection === "tryon" ? "primary" : "ghost"} closet-tab" data-section="tryon">Try-ons</button><button class="btn ${closetSection === "uploaded" ? "primary" : "ghost"} closet-tab" data-section="uploaded">Uploaded</button></div><p class="muted closet-multi-hint">Select <strong>one or more</strong> items, then <strong>Try On Selected</strong> — choose <strong>full body</strong> or <strong>avatar</strong> mode.</p><button id="tryon-selected" class="btn primary">${generating ? "Generating..." : "Try On Selected Items"}</button><div class="grid">${items.map((item: any) => {
    const outfitImg = item.outfits?.image_url || "";
    const thumb = outfitImg || item.tryon_image_url || "";
    const title = (item.metadata?.original_outfit_title || item.outfits?.title || "Outfit") + "";
    const m = item?.metadata || {};
    const isUploadedPost = m.is_uploaded_outfit === true && item.outfit_id;
    const removeOrDelete = isUploadedPost
      ? `<button type="button" class="btn danger delete-uploaded-post" data-outfit-id="${escAttr(String(item.outfit_id))}">Delete post</button>`
      : `<button type="button" class="btn danger remove-closet" data-id="${item.id}">Remove</button>`;
    return `<article class="item card closet-item-card" style="padding:8px"><img class="clothes-thumb zoomable-img" tabindex="0" src="${escAttr(thumb)}" alt="${escAttr(title)}" title="Tap for full size" /><div class="muted">${new Date(item.created_at).toLocaleString()}</div><div class="row"><label class="muted"><input class="select-tryon" type="checkbox" data-id="${item.id}" data-outfit-id="${item.outfit_id || ""}" data-title="${title.replace(/"/g, "&quot;")}" data-image="${thumb.replace(/"/g, "&quot;")}" style="width:auto;margin-right:6px" />Select</label>${removeOrDelete}</div></article>`;
  }).join("")}</div></div>`;
}

async function renderCurrent(forceGuide = false) {
  const content =
    activeTab === "Explore"
      ? await renderExplore()
      : activeTab === "Setup"
        ? await renderSetup()
        : activeTab === "TryOn"
          ? await renderTryOn()
          : await renderCloset();
  shell(content, forceGuide || (await shouldShowManual(activeTab)));

  document.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((btn) => (btn.onclick = async () => { activeTab = btn.dataset.tab as Tab; await renderCurrent(); }));
  document.getElementById("signOutBtn")!.onclick = async () => { await supabase.auth.signOut(); await bootstrap(); };
  document.getElementById("manualClose")?.addEventListener("click", () => document.getElementById("manualOverlay")?.remove());
  document.getElementById("manualDontShow")?.addEventListener("click", async () => { await hideManualPermanently(activeTab); document.getElementById("manualOverlay")?.remove(); });

  document.getElementById("tryonModeFullBody")?.addEventListener("click", async () => {
    hideTryonModeModal();
    await runTryOnAfterModeChoice("photo");
  });
  document.getElementById("tryonModeAvatar")?.addEventListener("click", async () => {
    hideTryonModeModal();
    await runTryOnAfterModeChoice("avatar");
  });
  document.getElementById("tryonModeCancel")?.addEventListener("click", () => {
    pendingTryOn = null;
    hideTryonModeModal();
  });

  document.getElementById("lightboxClose")?.addEventListener("click", closeImageLightbox);
  document.getElementById("imageLightbox")?.addEventListener("click", (ev) => {
    if (ev.target === document.getElementById("imageLightbox")) closeImageLightbox();
  });

  document.querySelectorAll<HTMLImageElement>(".zoomable-img").forEach((img) => {
    img.addEventListener("click", () => openImageLightbox(img.src));
    img.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        openImageLightbox(img.src);
      }
    });
  });

  document.querySelectorAll<HTMLButtonElement>(".explore-pin-like").forEach((btn) => {
    btn.addEventListener("click", (ev) => ev.stopPropagation());
  });

  document.querySelectorAll<HTMLButtonElement>(".explore-quick-trigger").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const outfitId = btn.dataset.outfitId;
      if (!outfitId) return;
      exploreQuickContext = {
        outfitId,
        imageUrl: btn.dataset.image || "",
        title: btn.dataset.title || "Outfit",
        desc: btn.dataset.desc || "",
        saved: btn.dataset.saved === "1"
      };
      showExploreQuickOverlay();
    });
  });

  const exploreQuickOv = document.getElementById("exploreQuickOverlay");
  if (exploreQuickOv) {
    exploreQuickOv.onclick = (ev) => {
      if (ev.target === exploreQuickOv) hideExploreQuickOverlay();
    };
  }

  const exploreQuickCloseEl = document.getElementById("exploreQuickClose");
  if (exploreQuickCloseEl) exploreQuickCloseEl.onclick = () => hideExploreQuickOverlay();

  const exploreQuickSaveEl = document.getElementById("exploreQuickSave");
  if (exploreQuickSaveEl) {
    exploreQuickSaveEl.onclick = async () => {
      const ctx = exploreQuickContext;
      if (!ctx || !userId) return;
      const { error } = await supabase.from("closet").insert({ user_id: userId, outfit_id: ctx.outfitId });
      if (error) {
        alert(error.message);
        return;
      }
      hideExploreQuickOverlay();
      await renderCurrent();
    };
  }

  const exploreQuickUnsaveEl = document.getElementById("exploreQuickUnsave");
  if (exploreQuickUnsaveEl) {
    exploreQuickUnsaveEl.onclick = async () => {
      const ctx = exploreQuickContext;
      if (!ctx || !userId) return;
      const { error } = await supabase
        .from("closet")
        .delete()
        .eq("user_id", userId)
        .eq("outfit_id", ctx.outfitId)
        .is("tryon_image_url", null);
      if (error) {
        alert(error.message);
        return;
      }
      hideExploreQuickOverlay();
      await renderCurrent();
    };
  }

  const exploreQuickTryOnEl = document.getElementById("exploreQuickTryOn");
  if (exploreQuickTryOnEl) {
    exploreQuickTryOnEl.onclick = async () => {
      if (generating) return;
      const ctx = exploreQuickContext;
      if (!ctx) return;
      const copy = { ...ctx };
      hideExploreQuickOverlay();
      pendingTryOn = {
        kind: "single",
        data: {
          outfitId: copy.outfitId,
          title: copy.title,
          desc: copy.desc,
          image: copy.imageUrl
        }
      };
      showTryonModeModal();
    };
  }

  async function applyExploreFiltersFromDom() {
    exploreSearch = (document.getElementById("exploreSearch") as HTMLInputElement)?.value ?? "";
    exploreCategory = (document.getElementById("exploreCategory") as HTMLSelectElement)?.value ?? "all";
    exploreSort = ((document.getElementById("exploreSort") as HTMLSelectElement)?.value ?? "newest") as "newest" | "likes";
    await renderCurrent();
  }

  document.getElementById("applyExploreFilters")?.addEventListener("click", () => applyExploreFiltersFromDom());
  document.getElementById("exploreSearch")?.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      void applyExploreFiltersFromDom();
    }
  });

  document.getElementById("outfitFab")?.addEventListener("click", () => showOutfitPostModal());
  document.getElementById("outfitPostCancel")?.addEventListener("click", () => hideOutfitPostModal());
  document.getElementById("outfitPostOverlay")?.addEventListener("click", (ev) => {
    if (ev.target === document.getElementById("outfitPostOverlay")) hideOutfitPostModal();
  });

  document.getElementById("outfitPostSubmit")?.addEventListener("click", async () => {
    const fileInput = document.getElementById("outfitPostFile") as HTMLInputElement;
    const titleEl = document.getElementById("outfitPostTitle") as HTMLInputElement;
    const descEl = document.getElementById("outfitPostDesc") as HTMLTextAreaElement;
    const catEl = document.getElementById("outfitPostCategory") as HTMLInputElement;
    const title = titleEl?.value.trim() ?? "";
    const desc = descEl?.value ?? "";
    const cat = catEl?.value ?? "";
    const file = fileInput?.files?.[0];
    if (!file) return alert("Choose an outfit photo.");
    try {
      await publishOutfitPost(title, desc, cat, file);
      fileInput.value = "";
      if (titleEl) titleEl.value = "";
      if (descEl) descEl.value = "";
      if (catEl) catEl.value = "";
      hideOutfitPostModal();
      alert("Published! Your outfit is on Explore and in Closet → Uploaded.");
      await renderCurrent();
    } catch (e: any) {
      alert(e?.message || "Could not publish. Check the outfits storage bucket and database policies.");
    }
  });

  async function getSessionEmail() {
    const { data: { user } } = await supabase.auth.getUser();
    return user?.email ?? null;
  }

  document.querySelectorAll<HTMLButtonElement>(".setup-seg-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const v = btn.dataset.setupSeg as "photo" | "avatar" | undefined;
      if (!v) return;
      setupSegment = v;
      sessionStorage.setItem("vc_setup_segment", v);
      await renderCurrent();
    });
  });

  document.getElementById("setupSkipPhoto")?.addEventListener("click", async () => {
    const email = await getSessionEmail();
    const { error } = await supabase
      .from("profiles")
      .update({
        profile_mode: "photo",
        email: email ?? null,
        display_name: email?.split("@")[0] ?? "User"
      })
      .eq("id", userId!);
    if (error) alert(error.message);
    else alert("Skipped — you can finish photo setup anytime from this tab.");
    await renderCurrent();
  });

  document.getElementById("setupCompletePhoto")?.addEventListener("click", async () => {
    const { data: p } = await supabase.from("profiles").select("full_body_image_url").eq("id", userId!).single();
    if (!p?.full_body_image_url) {
      return alert("Please upload a full-body photo first.");
    }
    const email = await getSessionEmail();
    await supabase
      .from("profiles")
      .update({
        profile_mode: "photo",
        email: email ?? null,
        display_name: email?.split("@")[0] ?? "User",
        full_body_image_url: p.full_body_image_url
      })
      .eq("id", userId!);
    alert("Setup complete! Your photo profile is ready.");
    activeTab = "Explore";
    await renderCurrent();
  });

  document.getElementById("setupSkipAvatar")?.addEventListener("click", async () => {
    const email = await getSessionEmail();
    const { error } = await supabase
      .from("profiles")
      .update({
        profile_mode: "avatar",
        email: email ?? null,
        display_name: email?.split("@")[0] ?? "User"
      })
      .eq("id", userId!);
    if (error) alert(error.message);
    else alert("Skipped — you can finish avatar setup anytime from this tab.");
    await renderCurrent();
  });

  document.getElementById("saveAvatarBody")?.addEventListener("click", async () => {
    const h = parseFloat((document.getElementById("avatarHeight") as HTMLInputElement).value);
    const w = parseFloat((document.getElementById("avatarWeight") as HTMLInputElement).value);
    const bt = (document.getElementById("avatarBodyType") as HTMLInputElement).value.trim();
    const { error } = await supabase
      .from("profiles")
      .update({
        height_cm: Number.isFinite(h) ? h : null,
        weight_kg: Number.isFinite(w) ? w : null,
        body_type: bt || null
      })
      .eq("id", userId!);
    if (error) alert(error.message);
    else alert("Body details saved.");
  });

  document.getElementById("setupCompleteAvatar")?.addEventListener("click", async () => {
    const { data: p } = await supabase.from("profiles").select("face_image_url").eq("id", userId!).single();
    if (!p?.face_image_url) {
      return alert("Please upload a face photo first.");
    }
    const h = parseFloat((document.getElementById("avatarHeight") as HTMLInputElement).value);
    const w = parseFloat((document.getElementById("avatarWeight") as HTMLInputElement).value);
    const bt = (document.getElementById("avatarBodyType") as HTMLInputElement).value.trim();
    const email = await getSessionEmail();
    const { error } = await supabase
      .from("profiles")
      .update({
        profile_mode: "avatar",
        email: email ?? null,
        display_name: email?.split("@")[0] ?? "User",
        face_image_url: p.face_image_url,
        height_cm: Number.isFinite(h) ? h : null,
        weight_kg: Number.isFinite(w) ? w : null,
        body_type: bt || null
      })
      .eq("id", userId!);
    if (error) alert(error.message);
    else {
      alert("Setup complete! Your avatar profile is ready.");
      activeTab = "Explore";
    }
    await renderCurrent();
  });

  document.getElementById("fullBodyFile")?.addEventListener("change", async (ev) => {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    try {
      const url = await uploadReferenceImage("full_bodies", file);
      const { error } = await supabase
        .from("profiles")
        .update({ full_body_image_url: url, profile_mode: "photo" })
        .eq("id", userId!);
      if (error) throw error;
      alert("Full-body photo saved.");
    } catch (e: any) {
      alert(e?.message || "Upload failed. Check Storage policies and buckets (full_bodies).");
    } finally {
      input.value = "";
      await renderCurrent();
    }
  });

  document.getElementById("faceFile")?.addEventListener("change", async (ev) => {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    try {
      const url = await uploadReferenceImage("avatars", file);
      const { error } = await supabase
        .from("profiles")
        .update({ face_image_url: url, avatar_image_url: url, profile_mode: "avatar" })
        .eq("id", userId!);
      if (error) throw error;
      alert("Face photo saved for avatar mode.");
    } catch (e: any) {
      alert(e?.message || "Upload failed. Check Storage policies and buckets (avatars).");
    } finally {
      input.value = "";
      await renderCurrent();
    }
  });

  document.querySelectorAll<HTMLButtonElement>(".like-btn").forEach((btn) => (btn.onclick = async () => {
    const outfit_id = btn.dataset.id!;
    const liked = btn.dataset.liked === "1";
    if (liked) await supabase.from("outfit_likes").delete().eq("outfit_id", outfit_id).eq("user_id", userId);
    else await supabase.from("outfit_likes").insert({ outfit_id, user_id: userId });
    await renderCurrent();
  }));

  document.querySelectorAll<HTMLButtonElement>(".tryon-single").forEach((btn) => (btn.onclick = async () => {
    if (generating) return;
    btn.closest("details")?.removeAttribute("open");
    pendingTryOn = {
      kind: "single",
      data: {
        outfitId: btn.dataset.id || null,
        title: btn.dataset.title || "Outfit",
        desc: btn.dataset.desc || "",
        image: btn.dataset.image || ""
      }
    };
    showTryonModeModal();
  }));

  document.querySelectorAll<HTMLButtonElement>(".delete-tryon").forEach((btn) => (btn.onclick = async () => {
    await supabase.from("closet").delete().eq("id", btn.dataset.id!).eq("user_id", userId);
    await renderCurrent();
  }));
  document.querySelectorAll<HTMLButtonElement>(".save-tryon").forEach((btn) => (btn.onclick = async () => {
    const id = btn.dataset.id!;
    const { data } = await supabase.from("closet").select("metadata").eq("id", id).single();
    await supabase.from("closet").update({ metadata: { ...(data?.metadata || {}), is_saved_outfit: true, is_tryon_result: false, saved_at: new Date().toISOString() } }).eq("id", id);
    await renderCurrent();
  }));

  document.querySelectorAll<HTMLButtonElement>(".closet-tab").forEach((btn) => (btn.onclick = async () => {
    closetSection = btn.dataset.section as any;
    await renderCurrent();
  }));
  document.querySelectorAll<HTMLButtonElement>(".remove-closet").forEach((btn) => (btn.onclick = async () => {
    await supabase.from("closet").delete().eq("id", btn.dataset.id!).eq("user_id", userId);
    await renderCurrent();
  }));

  document.querySelectorAll<HTMLButtonElement>(".delete-uploaded-post").forEach((btn) => (btn.onclick = async () => {
    const outfitId = btn.dataset.outfitId;
    if (!outfitId) return;
    if (!confirm("Delete this post from Explore and remove the outfit permanently? This cannot be undone.")) return;
    try {
      await deleteUploadedOutfitPost(outfitId);
      alert("Your post was deleted.");
      await renderCurrent();
    } catch (e: any) {
      alert(e?.message || "Could not delete. Check database policies and foreign keys.");
    }
  }));

  const tryOnSelectedBtn = document.getElementById("tryon-selected");
  if (tryOnSelectedBtn) {
    tryOnSelectedBtn.onclick = async () => {
      if (generating) return;
      const checks = Array.from(document.querySelectorAll<HTMLInputElement>(".select-tryon:checked"));
      if (checks.length < 1) return alert("Select at least one item to try on.");
      pendingTryOn = {
        kind: "multi",
        data: {
          outfits: checks.map((c) => ({
            url: c.dataset.image || "",
            title: c.dataset.title || "Outfit",
            description: ""
          }))
        }
      };
      showTryonModeModal();
    };
  }

}

async function bootstrap() {
  const { data } = await supabase.auth.getSession();
  userId = data.session?.user?.id ?? null;
  if (!userId) return renderAuth();
  await ensureProfile(data.session?.user?.email);
  await renderCurrent();
}

bootstrap();
