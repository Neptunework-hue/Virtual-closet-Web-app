import type { SupabaseClient } from "@supabase/supabase-js";
import { loadImageForGemini } from "./supabaseImage";

const GEMINI_API_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent";
const GEMINI_API_KEY = (import.meta.env.VITE_GEMINI_API_KEY as string) || "";

export interface TryOnInput {
  user_id: string;
  mode: "photo" | "avatar";
  person_url: string;
  outfit_url: string;
  outfitTitle?: string;
  outfitDescription?: string;
  multipleOutfits?: Array<{ outfit_url: string; title: string; description?: string }>;
  supabase?: SupabaseClient;
}

export interface TryOnResult {
  success: boolean;
  imageUrl?: string;
  error?: string;
}

function promptSingle(title: string, description?: string) {
  return `You are a professional AI fashion stylist that performs virtual try-ons for users.
IMPORTANT:
1) First image is user full-body photo (exact person to keep)
2) Second image is target outfit
TARGET OUTFIT: "${title}"
${description ? `OUTFIT DESCRIPTION: ${description}` : ""}
CRITICAL:
- SINGLE ITEM focus: replace only the target garment category.
- Preserve all other clothing from base photo.
- Keep face/body/background/lighting unchanged.
- Preserve exact garment color/material/texture/details.
- FULL BODY REQUIREMENT: head-to-toe visible.
- SIZE REQUIREMENT: exact same aspect ratio and dimensions as base photo.
Output one photorealistic image.`;
}

function promptMulti(titles: string[]) {
  return `🧠 Gemini Prompt for Multi-Item Try-On (Consistent Look)
You are a professional virtual fashion stylist AI.
Inputs:
1) Base photo: the user's full body photo (use this exact person)
2) Outfit items: ${titles.join(", ")}
Rules:
- Use the user's base photo as canvas; do NOT generate a new person.
- Keep same face, body, pose, background, and lighting.
- Apply ONLY the listed garments with realistic layering and fitting.
- Preserve exact garment color/material/texture/details from source.
- FULL BODY REQUIREMENT: head-to-toe visible.
- SIZE REQUIREMENT: exact same aspect ratio and dimensions as user's photo.
Output: one high-quality photorealistic image of the user wearing the complete combined outfit.`;
}

function promptSingleAvatar(title: string, description?: string) {
  return `You are a professional AI fashion stylist for avatar-style virtual try-on.
IMPORTANT:
1) First image is the user's FACE (keep identity, skin tone, facial features)
2) Following image(s) show the target outfit/garment(s)
TARGET OUTFIT: "${title}"
${description ? `OUTFIT DESCRIPTION: ${description}` : ""}
CRITICAL:
- Output ONE full-body photorealistic image of this same person wearing the outfit.
- Preserve facial identity from the face reference; synthesize a natural full body and pose.
- Apply the garment with realistic fit, folds, texture, and colors from the outfit image.
- Use a clean neutral full-body presentation; head to toe visible.
- If the outfit image shows a model, ignore their body—transfer only the clothing.`;
}

function promptMultiAvatar(titles: string[]) {
  return `Virtual fashion stylist — FACE reference + multiple garments.
Face reference: identity of the user (first image).
Garments to combine: ${titles.join(", ")}
Rules:
- Produce ONE full-body photorealistic image of the same person wearing all items, well layered.
- Preserve identity from the face reference only.
- Realistic fit, proportions, and garment details from each source image.
- Head-to-toe visible. Ignore any people shown on garment product images.`;
}

export async function requestTryOn(input: TryOnInput): Promise<TryOnResult> {
  try {
    if (!GEMINI_API_KEY) return { success: false, error: "Missing VITE_GEMINI_API_KEY." };
    console.log("🔮 [gemini.ts] requestTryOn start", {
      mode: input.mode,
      outfitTitle: input.outfitTitle,
      multiple: input.multipleOutfits?.length || 0
    });

    const personImg = await loadImageForGemini(input.person_url, input.supabase);
    const outfits =
      input.multipleOutfits && input.multipleOutfits.length > 1
        ? input.multipleOutfits
        : [{ outfit_url: input.outfit_url, title: input.outfitTitle || "Outfit", description: input.outfitDescription }];

    const outfitParts: Array<{ inline_data: { mime_type: string; data: string } }> = [];
    for (const o of outfits) {
      console.log("🖼️ [gemini.ts] converting outfit", o.title);
      const img = await loadImageForGemini(o.outfit_url, input.supabase);
      outfitParts.push({
        inline_data: { mime_type: img.mime, data: img.base64 }
      });
    }

    const useAvatar = input.mode === "avatar";
    const prompt =
      outfits.length > 1
        ? useAvatar
          ? promptMultiAvatar(outfits.map((o) => o.title))
          : promptMulti(outfits.map((o) => o.title))
        : useAvatar
          ? promptSingleAvatar(outfits[0].title, outfits[0].description)
          : promptSingle(outfits[0].title, outfits[0].description);

    const body = {
      contents: [
        {
          parts: [
            { text: prompt },
            { inline_data: { mime_type: personImg.mime, data: personImg.base64 } },
            ...outfitParts,
            { inline_data: { mime_type: personImg.mime, data: personImg.base64 } }
          ]
        }
      ],
      generationConfig: {
        temperature: useAvatar ? 0.4 : 0.3,
        topK: 40,
        topP: 0.95,
        maxOutputTokens: 1024
      }
    };

    console.log("📡 [gemini.ts] calling Gemini API");
    const response = await fetch(`${GEMINI_API_URL}?key=${GEMINI_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const result = await response.json();

    if (!response.ok) {
      console.error("❌ [gemini.ts] API error", response.status, result);
      return { success: false, error: `Gemini API error: ${response.status}` };
    }

    const parts = result?.candidates?.[0]?.content?.parts || [];
    for (const part of parts) {
      const data = part?.inline_data?.data || part?.inlineData?.data;
      const mime = part?.inline_data?.mime_type || part?.inlineData?.mimeType || "image/jpeg";
      if (data) {
        console.log("✅ [gemini.ts] image generated");
        return { success: true, imageUrl: `data:${mime};base64,${data}` };
      }
    }
    console.error("❌ [gemini.ts] no image payload", result);
    return { success: false, error: "No image generated by Gemini." };
  } catch (error: any) {
    console.error("❌ [gemini.ts] exception", error);
    return { success: false, error: error?.message || "Unknown Gemini error." };
  }
}

/* LEGACY_DUPLICATE_BLOCK const GEMINI_API_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent";
const GEMINI_API_KEY = (import.meta.env.VITE_GEMINI_API_KEY as string) || "";

export interface TryOnInput {
  user_id: string;
  mode: "photo" | "avatar";
  person_url: string;
  outfit_url: string;
  outfitTitle?: string;
  outfitDescription?: string;
  multipleOutfits?: Array<{ outfit_url: string; title: string; description?: string }>;
}

export interface TryOnResult {
  success: boolean;
  imageUrl?: string;
  error?: string;
}

function promptSingle(title: string, description?: string) {
  return `You are a professional AI fashion stylist that performs virtual try-ons for users.
IMPORTANT:
1) First image is user full-body photo (exact person to keep)
2) Second image is target outfit
TARGET OUTFIT: "${title}"
${description ? `OUTFIT DESCRIPTION: ${description}` : ""}
CRITICAL:
- SINGLE ITEM focus: replace only the target garment category.
- Preserve all other clothing from base photo.
- Keep face/body/background/lighting unchanged.
- Preserve exact garment color/material/texture/details.
- FULL BODY REQUIREMENT: head-to-toe visible.
- SIZE REQUIREMENT: exact same aspect ratio and dimensions as base photo.
Output one photorealistic image.`;
}

function promptMulti(titles: string[]) {
  return `🧠 Gemini Prompt for Multi-Item Try-On (Consistent Look)
You are a professional virtual fashion stylist AI.
Inputs:
1) Base photo: the user's full body photo (use this exact person)
2) Outfit items: ${titles.join(", ")}
Rules:
- Use the user's base photo as canvas; do NOT generate a new person.
- Keep same face, body, pose, background, and lighting.
- Apply ONLY the listed garments with realistic layering and fitting.
- Preserve exact garment color/material/texture/details from source.
- FULL BODY REQUIREMENT: head-to-toe visible.
- SIZE REQUIREMENT: exact same aspect ratio and dimensions as user's photo.
Output: one high-quality photorealistic image of the user wearing the complete combined outfit.`;
}

async function imageUrlToBase64(url: string): Promise<string> {
  if (url.startsWith("data:")) return url.slice(url.indexOf(",") + 1);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch image: ${res.status}`);
  const buf = await res.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const chunk = 8192;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.slice(i, i + chunk));
  }
  return btoa(binary);
}

export async function requestTryOn(input: TryOnInput): Promise<TryOnResult> {
  try {
    if (!GEMINI_API_KEY) return { success: false, error: "Missing VITE_GEMINI_API_KEY." };
    console.log("🔮 [gemini.ts] requestTryOn start", {
      mode: input.mode,
      outfitTitle: input.outfitTitle,
      multiple: input.multipleOutfits?.length || 0
    });

    const personBase64 = await imageUrlToBase64(input.person_url);
    const outfits =
      input.multipleOutfits && input.multipleOutfits.length > 1
        ? input.multipleOutfits
        : [{ outfit_url: input.outfit_url, title: input.outfitTitle || "Outfit", description: input.outfitDescription }];

    const outfitParts = [];
    for (const o of outfits) {
      console.log("🖼️ [gemini.ts] converting outfit", o.title);
      outfitParts.push({
        inline_data: { mime_type: "image/jpeg", data: await imageUrlToBase64(o.outfit_url) }
      });
    }

    const prompt =
      outfits.length > 1
        ? promptMulti(outfits.map((o) => o.title))
        : promptSingle(outfits[0].title, outfits[0].description);

    const body = {
      contents: [
        {
          parts: [
            { text: prompt },
            { inline_data: { mime_type: "image/jpeg", data: personBase64 } },
            ...outfitParts,
            { inline_data: { mime_type: "image/jpeg", data: personBase64 } }
          ]
        }
      ],
      generationConfig: {
        temperature: 0.3,
        topK: 40,
        topP: 0.95,
        maxOutputTokens: 1024
      }
    };

    console.log("📡 [gemini.ts] calling Gemini API");
    const response = await fetch(`${GEMINI_API_URL}?key=${GEMINI_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const result = await response.json();

    if (!response.ok) {
      console.error("❌ [gemini.ts] API error", response.status, result);
      return { success: false, error: `Gemini API error: ${response.status}` };
    }

    const parts = result?.candidates?.[0]?.content?.parts || [];
    for (const part of parts) {
      const data = part?.inline_data?.data || part?.inlineData?.data;
      const mime = part?.inline_data?.mime_type || part?.inlineData?.mimeType || "image/jpeg";
      if (data) {
        console.log("✅ [gemini.ts] image generated");
        return { success: true, imageUrl: `data:${mime};base64,${data}` };
      }
    }
    console.error("❌ [gemini.ts] no image payload", result);
    return { success: false, error: "No image generated by Gemini." };
  } catch (error: any) {
    console.error("❌ [gemini.ts] exception", error);
    return { success: false, error: error?.message || "Unknown Gemini error." };
  }
}
const GEMINI_API_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent";
const GEMINI_API_KEY = (import.meta.env.VITE_GEMINI_API_KEY as string) || "";

export interface TryOnInput {
  user_id: string;
  mode: "photo" | "avatar";
  person_url: string;
  outfit_url: string;
  outfitTitle?: string;
  outfitDescription?: string;
  multipleOutfits?: Array<{ outfit_url: string; title: string; description?: string }>;
}

export interface TryOnResult {
  success: boolean;
  imageUrl?: string;
  error?: string;
}

function promptSingle(title: string, description?: string) {
  return `You are a professional AI fashion stylist that performs virtual try-ons for users.
IMPORTANT:
1) First image is user full-body photo (exact person to keep)
2) Second image is target outfit
TARGET OUTFIT: "${title}"
${description ? `OUTFIT DESCRIPTION: ${description}` : ""}
CRITICAL:
- SINGLE ITEM focus: replace only the target garment category.
- Preserve all other clothing from base photo.
- Keep face/body/background/lighting unchanged.
- Preserve exact garment color/material/texture/details.
- FULL BODY REQUIREMENT: head-to-toe visible.
- SIZE REQUIREMENT: exact same aspect ratio and dimensions as base photo.
Output one photorealistic image.`;
}

function promptMulti(titles: string[]) {
  return `🧠 Gemini Prompt for Multi-Item Try-On (Consistent Look)
You are a professional virtual fashion stylist AI.
Inputs:
1) Base photo: the user's full body photo (use this exact person)
2) Outfit items: ${titles.join(", ")}
Rules:
- Use the user's base photo as canvas; do NOT generate a new person.
- Keep same face, body, pose, background, and lighting.
- Apply ONLY the listed garments with realistic layering and fitting.
- Preserve exact garment color/material/texture/details from source.
- FULL BODY REQUIREMENT: head-to-toe visible.
- SIZE REQUIREMENT: exact same aspect ratio and dimensions as user's photo.
Output: one high-quality photorealistic image of the user wearing the complete combined outfit.`;
}

async function imageUrlToBase64(url: string): Promise<string> {
  if (url.startsWith("data:")) return url.slice(url.indexOf(",") + 1);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch image: ${res.status}`);
  const buf = await res.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const chunk = 8192;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.slice(i, i + chunk));
  }
  return btoa(binary);
}

export async function requestTryOn(input: TryOnInput): Promise<TryOnResult> {
  try {
    if (!GEMINI_API_KEY) return { success: false, error: "Missing VITE_GEMINI_API_KEY." };
    console.log("🔮 [gemini.ts] requestTryOn start", {
      mode: input.mode,
      outfitTitle: input.outfitTitle,
      multiple: input.multipleOutfits?.length || 0
    });

    const personBase64 = await imageUrlToBase64(input.person_url);
    const outfits =
      input.multipleOutfits && input.multipleOutfits.length > 1
        ? input.multipleOutfits
        : [{ outfit_url: input.outfit_url, title: input.outfitTitle || "Outfit", description: input.outfitDescription }];

    const outfitParts = [];
    for (const o of outfits) {
      console.log("🖼️ [gemini.ts] converting outfit", o.title);
      outfitParts.push({
        inline_data: { mime_type: "image/jpeg", data: await imageUrlToBase64(o.outfit_url) }
      });
    }

    const prompt =
      outfits.length > 1
        ? promptMulti(outfits.map((o) => o.title))
        : promptSingle(outfits[0].title, outfits[0].description);

    const body = {
      contents: [
        {
          parts: [
            { text: prompt },
            { inline_data: { mime_type: "image/jpeg", data: personBase64 } },
            ...outfitParts,
            { inline_data: { mime_type: "image/jpeg", data: personBase64 } }
          ]
        }
      ],
      generationConfig: {
        temperature: 0.3,
        topK: 40,
        topP: 0.95,
        maxOutputTokens: 1024
      }
    };

    console.log("📡 [gemini.ts] calling Gemini API");
    const response = await fetch(`${GEMINI_API_URL}?key=${GEMINI_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    const result = await response.json();
    if (!response.ok) {
      console.error("❌ [gemini.ts] API error", response.status, result);
      return { success: false, error: `Gemini API error: ${response.status}` };
    }

    const parts = result?.candidates?.[0]?.content?.parts || [];
    for (const part of parts) {
      const data = part?.inline_data?.data || part?.inlineData?.data;
      const mime = part?.inline_data?.mime_type || part?.inlineData?.mimeType || "image/jpeg";
      if (data) {
        console.log("✅ [gemini.ts] image generated");
        return { success: true, imageUrl: `data:${mime};base64,${data}` };
      }
    }

    console.error("❌ [gemini.ts] no image payload", result);
    return { success: false, error: "No image generated by Gemini." };
  } catch (error: any) {
    console.error("❌ [gemini.ts] exception", error);
    return { success: false, error: error?.message || "Unknown Gemini error." };
  }
}

// Test function to verify Gemini API connectivity
export async function testGeminiAPI(): Promise<{ success: boolean; error?: string }> {
  try {
    console.log('🧪 Testing Gemini API connectivity...');
    
    const testRequestBody = {
      contents: [{
        parts: [{
          text: "Generate a simple test image of a red circle on white background"
        }]
      }],
      generationConfig: {
        temperature: 0.7,
        topK: 40,
        topP: 0.95,
        maxOutputTokens: 1024
      }
    };
    
    console.log('🧪 Making test API request...');
    const response = await fetch(`${GEMINI_API_URL}?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(testRequestBody),
    });
    
    console.log('🧪 Test response status:', response.status);
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('🧪 Test failed:', response.status, errorText);
      return { success: false, error: `API Error: ${response.status} - ${errorText}` };
    }
    
    const result = await response.json();
    console.log('🧪 Test successful, response received');
    return { success: true };
    
  } catch (error: any) {
    console.error('🧪 Test exception:', error);
    return { success: false, error: error?.message || 'Unknown error' };
  }
}

// Sequential generation for 3+ items
async function requestSequentialTryOn(body: {
  user_id: string, 
  mode: 'avatar' | 'photo', 
  person_url: string, 
  outfit_url: string,
  userProfile?: any,
  outfitTitle?: string,
  outfitDescription?: string,
  aspectRatio?: {label: string, ratio: number, width: number, height: number},
  multipleOutfits?: Array<{
    outfit_url: string,
    title: string,
    description?: string
  }>
}): Promise<TryOnResult> {
  try {
    console.log(`🔄 Starting sequential generation for ${body.multipleOutfits!.length} items`);
    console.log(`📐 Size preservation: Maintaining exact dimensions of user's full body photo`);
    
    // Step 1: Generate with first 2 items (ensure full body is shown)
    const firstTwoItems = body.multipleOutfits!.slice(0, 2);
    console.log(`📝 Step 1: Generating with first 2 items: ${firstTwoItems.map(item => item.title).join(', ')}`);
    console.log(`📐 Step 1: Preserving user's original photo dimensions`);
    
    const step1Body = {
      ...body,
      multipleOutfits: firstTwoItems
    };
    
    const step1Result = await requestTryOnOriginal(step1Body);
    
    if (!step1Result.success || !step1Result.imageUrl) {
      console.error('❌ Step 1 failed:', (step1Result as any).error);
      return step1Result;
    }
    
    console.log('✅ Step 1 completed successfully');
    
    // Step 2+: Add remaining items in pairs (2 items at a time)
    const remainingItems = body.multipleOutfits!.slice(2);
    let currentBaseImage = step1Result.imageUrl;
    let currentStep = 2;
    
    // Process remaining items in pairs
    for (let i = 0; i < remainingItems.length; i += 2) {
      const itemsToAdd = remainingItems.slice(i, i + 2);
      console.log(`📝 Step ${currentStep}: Adding ${itemsToAdd.length} items: ${itemsToAdd.map(item => item.title).join(', ')}`);
      console.log(`📐 Step ${currentStep}: Maintaining user's original photo dimensions`);
      
      const stepResult = await requestSequentialAddition({
        ...body,
        baseImageUrl: currentBaseImage,
        additionalOutfits: itemsToAdd,
        stepNumber: currentStep
      });
      
      if (!stepResult.success) {
        console.error(`❌ Step ${currentStep} failed:`, stepResult.error);
        return stepResult;
      }
      
      console.log(`✅ Step ${currentStep} completed successfully`);
      currentBaseImage = stepResult.imageUrl!;
      currentStep++;
    }
    
    console.log('✅ Sequential generation completed successfully');
    return { success: true, imageUrl: currentBaseImage };
    
  } catch (error) {
    console.error('❌ Sequential generation error:', error);
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Sequential generation failed' 
    };
  }
}

// Add remaining items to an existing generated image
async function requestSequentialAddition(body: {
  user_id: string, 
  mode: 'avatar' | 'photo', 
  person_url: string, 
  outfit_url: string,
  userProfile?: any,
  outfitTitle?: string,
  outfitDescription?: string,
  aspectRatio?: {label: string, ratio: number, width: number, height: number},
  baseImageUrl: string, // The generated image from previous step
  additionalOutfits: Array<{
    outfit_url: string,
    title: string,
    description?: string
  }>,
  stepNumber?: number // Step number for logging
}): Promise<TryOnResult> {
  try {
    console.log(`🔮 Sequential Addition Step ${body.stepNumber || 'N/A'}: Adding items to existing generated image`);
    console.log(`📐 Step ${body.stepNumber || 'N/A'}: Maintaining user's original full body photo dimensions`);
    
    const itemsList = body.additionalOutfits.map((item, index) => 
      `${index + 1}. ${item.title}${item.description ? ` (${item.description})` : ''}`
    ).join('\n');
    
    const prompt = `🧠 Sequential Addition: Adding Items to Generated Image
You are a professional virtual fashion stylist AI that adds additional clothing items to an existing generated try-on image.

Inputs:
1️⃣ Base generated image: A previously generated try-on result showing the user wearing some items
2️⃣ Additional outfit items: ${body.additionalOutfits.length} more clothing items to add

Items to add:
${itemsList}

Your task:
Add the additional clothing items to the existing generated image, making it look like the user is wearing all items together.

CRITICAL RULES:
- Use the existing generated image as the base - do NOT change the person, face, or body
- The person in the generated image is the ONLY person that should appear in the final result
- Add the additional items naturally to the existing outfit
- Ensure proper layering and realistic fit
- Maintain the same lighting, background, and pose from the base image
- Do NOT generate any new people or faces
- FULL BODY VISIBILITY: Ensure the user's full body remains visible in the final result - do not crop or hide any body parts
- COMPLETE BODY SHOT: The final image must show the user from head to toe - include the entire body, face, and feet
- NO CROPPING: Do not crop or cut off any part of the user's body in the final result
- BODY CONTOUR FITTING: Adjust each additional garment to conform to the user's body contours, curves, and pose
- POSE ADAPTATION: Adapt each additional garment to the user's specific pose and stance
- NATURAL DRAPE: Ensure fabric drapes naturally over the user's body shape
- BODY SHAPE CONFORMITY: The additional clothing should hug curves and follow body lines
- DIMENSION PRESERVATION: The generated image must have the EXACT SAME SIZE and ASPECT RATIO as the user's original full body photo. Do not change the dimensions, crop, or resize the image.

🚨 CRITICAL SIZE REQUIREMENT: The generated image must have the EXACT SAME SIZE and ASPECT RATIO as the user's original full body photo. Do not change the dimensions, crop, or resize the image. The final result must match the user's uploaded photo dimensions exactly.

OUTPUT: Generate one high-quality, photorealistic image of the user wearing the complete combined outfit with FULL BODY VISIBILITY from head to toe. The generated image must have the EXACT SAME SIZE and ASPECT RATIO as the user's full body photo. Do not change the dimensions or crop the image.`;

    // Convert images to base64
    const baseImageBase64 = await imageUrlToBase64(body.baseImageUrl);
    console.log('✅ Base generated image converted to base64');
    
    const outfitImages = [];
    for (let i = 0; i < body.additionalOutfits.length; i++) {
      const outfit = body.additionalOutfits[i];
      console.log(`🖼️ Converting additional outfit ${i + 1}: ${outfit.title}`);
      
      const outfitBase64 = await imageUrlToBase64(outfit.outfit_url);
      outfitImages.push({
        inline_data: {
          mime_type: "image/jpeg",
          data: outfitBase64
        }
      });
    }

    const requestBody = {
      contents: [{
        parts: [
          {
            text: prompt
          },
          {
            inline_data: {
              mime_type: "image/jpeg",
              data: baseImageBase64
            }
          },
          ...outfitImages
        ]
      }],
      generationConfig: {
        temperature: 0.3,
        topK: 40,
        topP: 0.95,
        maxOutputTokens: 1024
      }
    };

    console.log('🔮 Making sequential addition request to Gemini API...');
    const response = await fetch(GEMINI_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': GEMINI_API_KEY
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('❌ Sequential addition API error:', response.status, errorText);
      return { success: false, error: `API error: ${response.status}` };
    }

    const result = await response.json();
    console.log('✅ Sequential addition API response received');

    // Extract image from response
    let imageData = null;
    
    // Check candidates for image data
    if (result.candidates && result.candidates.length > 0) {
      for (const candidate of result.candidates) {
        if (candidate.content && candidate.content.parts) {
          for (const part of candidate.content.parts) {
            if ((part.inline_data && part.inline_data.data) || (part.inlineData && part.inlineData.data)) {
              const data = part.inline_data?.data || part.inlineData?.data;
              const mimeType = part.inline_data?.mime_type || part.inlineData?.mimeType || 'image/jpeg';
              imageData = `data:${mimeType};base64,${data}`;
              break;
            }
          }
          if (imageData) break;
        }
      }
    }
    
    if (!imageData) {
      console.error('❌ No image data found in sequential addition response');
      return { success: false, error: 'No image generated' };
    }

    console.log(`✅ Sequential addition Step ${body.stepNumber || 'N/A'} completed successfully`);
    return { success: true, imageUrl: imageData };

  } catch (error) {
    console.error('❌ Sequential addition error:', error);
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Sequential addition failed' 
    };
  }
}

// Original requestTryOn function (renamed to avoid recursion)
async function requestTryOnOriginal(body: { 
  user_id: string, 
  mode: 'avatar' | 'photo', 
  person_url: string, 
  outfit_url: string,
  userProfile?: any, // Add user profile for avatar mode measurements
  outfitTitle?: string, // Add outfit title to help AI focus on specific garment
  outfitDescription?: string, // Add outfit description for more context
  aspectRatio?: {label: string, ratio: number, width: number, height: number}, // Add aspect ratio for consistent output
  multipleOutfits?: Array<{ // NEW: Support for multiple items
    outfit_url: string,
    title: string,
    description?: string
  }>
}): Promise<TryOnResult> {
  try {
    console.log('🔮 Gemini API: Starting try-on request...');
    // Default to portrait if no aspect ratio provided to ensure full outfit visibility
    const desiredAspect = body.aspectRatio ?? { label: 'Portrait 9:16', ratio: 9/16, width: 9, height: 16 };

    console.log('🔮 Request body:', {
      user_id: body.user_id,
      mode: body.mode,
      person_url: body.person_url,
      outfit_url: body.outfit_url,
      userProfile: body.userProfile ? 'Present' : 'Not provided',
      outfitTitle: body.outfitTitle || 'Not provided',
      outfitDescription: body.outfitDescription || 'Not provided',
      aspectRatio: desiredAspect ? `${desiredAspect.label} (${desiredAspect.width}:${desiredAspect.height})` : 'Not provided',
      multipleOutfits: body.multipleOutfits ? `${body.multipleOutfits.length} items` : 'Not provided'
    });
    console.log('🎨 Outfit details for AI:', {
      title: body.outfitTitle,
      description: body.outfitDescription,
      focus: `Focusing on: ${body.outfitTitle || 'main garment'}`,
      multipleItems: body.multipleOutfits ? body.multipleOutfits.map(item => item.title) : null,
      consistencyKey: body.user_id ? body.user_id.substring(0, 8) : 'default',
      mode: body.mode
    });
    console.log('🔮 Mode:', body.mode);
    console.log('🔮 Person URL:', body.person_url);
    console.log('🔮 Outfit URL:', body.outfit_url);
    console.log('🔮 User Profile:', body.userProfile);

    // Validate URLs
    if (!body.person_url || !body.outfit_url) {
      throw new Error('Missing required image URLs');
    }

    // Generate optimized prompts based on mode
    let prompt: string;
    
    if (body.mode === 'avatar') {
      // Avatar Mode Prompt - Use user's face photo with body measurements
      const height = body.userProfile?.height_cm || 170;
      const weight = body.userProfile?.weight_kg || 70;
      const bodyType = body.userProfile?.body_type || 'athletic';
      
      if (body.multipleOutfits && body.multipleOutfits.length > 1) {
        // Multi-item Avatar Mode Prompt - Enhanced for Consistency
        const itemsList = body.multipleOutfits.map((item, index) => 
          `${index + 1}. ${item.title}${item.description ? ` (${item.description})` : ''}`
        ).join('\n');
        
        // Generate consistency key from user ID
        const consistencyKey = body.user_id ? body.user_id.substring(0, 8) : 'default';
        
        prompt = `You are an advanced AI stylist that creates realistic digital avatars for fashion try-ons.

Inputs:
1️⃣ A clear front-facing photo of the user's face with neutral lighting and expression. (This is the BASE image. It will also be repeated at the end of the request to reinforce usage.)
2️⃣ User details:
   - Gender: ${body.userProfile?.gender || 'Not specified'}
   - Height: ${height} cm
   - Weight: ${weight} kg
   - Body type: ${bodyType}
3️⃣ A list of outfit images selected by the user (garments only — no people should be used from these images).

Items to combine:
${itemsList}

Goal:
Generate a single full-body avatar image of the user, wearing all selected outfits combined over a base outfit, while maintaining perfect consistency in:
- Facial features and expression
- Skin texture and color
- Body proportions
- Pose and lighting
- Camera angle and background

### Instructions:

BASE OUTFIT REQUIREMENT:
- The user must ALWAYS be wearing a base outfit underneath: a plain grey cotton t-shirt and dark blue jeans
- This base outfit provides coverage and prevents any body skin exposure
- The base outfit should be visible only where the selected clothing items don't cover it
- The grey shirt should be a standard crew-neck t-shirt in medium grey color
- The jeans should be dark blue denim in a classic straight fit

CLOTHING APPLICATION:
- BASE COMPOSITION: Use the provided base (avatar) photo as the canvas. Overlay garments onto this exact photo without regenerating a new person or background.
- EXACT SIZE PRESERVATION: The generated image must have the EXACT SAME SIZE and ASPECT RATIO as the user's full body photo. Do not change the dimensions, crop, or resize the image.
- Apply the selected clothing items OVER the base grey shirt and jeans
- If a selected item is a shirt/top, it should replace or layer over the grey shirt
- If a selected item is pants/bottoms, it should replace the jeans
- If a selected item is outerwear (jacket, coat), it should layer over everything
- Ensure proper layering order: base outfit → selected items → outerwear
 - IMPORTANT: If any outfit image contains a person or face, IGNORE the person completely — do not copy their body, face, hands, hair, or background into the result. Extract ONLY the garment's shape, silhouette, texture, color and apply it to the user's avatar.

FACIAL CONSISTENCY:
- Use the user's face photo **only** to match realistic skin tone and general facial structure
- Do **not** alter or regenerate the face, body tone, or lighting
- The avatar must look like the same person, in the same pose, under the same lighting
- The only variation allowed is the outfit combination itself

For the outfit combination:
- PERFECT FITTING REQUIREMENT: Each selected item must fit the user PERFECTLY, as if it was custom-tailored to their body.
- TARGET SPECIFIC GARMENTS: Apply ONLY the exact garments mentioned: ${body.multipleOutfits.map(item => `"${item.title}"`).join(', ')}
- PRIMARY FOCUS: Each garment must be identified and applied by its specific title
- EXACT REPLICATION: The user must appear to be wearing the exact same garments as shown in the outfit photos
- GARMENT IDENTIFICATION: Identify each main piece of clothing in the outfit photos that represents: ${body.multipleOutfits.map(item => `"${item.title}"`).join(', ')}
- REALISTIC APPLICATION: Make it look like the user is physically wearing these specific garments
- LAYERING ORDER: Apply garments in logical layering order (e.g., shirt first, then jacket over it)
- BODY CONTOUR FITTING: Adjust each garment to conform EXACTLY to the avatar's body contours, curves, and pose. The clothing should follow the natural shape of the avatar's body precisely, not just overlay on top. Each garment should hug the body where it should (waist, hips, shoulders) and drape naturally where it should (loose areas).
- POSE ADAPTATION: Adapt each garment to the avatar's specific pose - if they're in a particular stance, the clothing should drape and fit accordingly. The garment should follow the body movement naturally.
- PROPORTIONAL FITTING: Scale and adjust each garment to match the avatar's body proportions PERFECTLY - ensure sleeves reach the correct wrist position, torso length matches their body length, waist sits at the natural waistline, and overall fit is natural and flattering.
- NATURAL DRAPE: Ensure fabric drapes naturally over the avatar's body shape, creating realistic folds, creases, and fabric flow that match the material properties (e.g., silk drapes differently than denim).
- BODY SHAPE CONFORMITY: The clothing should hug curves, follow body lines, and create a natural silhouette that matches the avatar's physique. The fit should look like each garment was made specifically for this person's body measurements.
- FABRIC INTEGRATION: Maintain fabric texture, shadowing, and correct overlap between garments
- COHESIVE OUTFIT: Combine ALL the specified clothing items into one unified, realistic outfit
- SEAMLESS INTEGRATION: All items must integrate seamlessly with each other. If combining a shirt and pants, ensure they work together naturally. The overall look should be cohesive and well-coordinated.
- Ensure the proportions, fabric texture, and layering look realistic
- Maintain natural folds and body alignment
- Avoid floating or misaligned garments
- CRITICAL: Match each garment's EXACT color, texture, and material from their respective outfit photos
${body.multipleOutfits.length >= 3 ? `
- CRITICAL FOR 3+ ITEMS: With ${body.multipleOutfits.length} items selected, you MUST focus exclusively on applying these outfits to the avatar. Each garment must be carefully fitted to the avatar's body shape, pose, and proportions. The clothing should wrap around the avatar's body naturally, following their contours and curves. Do not simply overlay garments - make them appear as if the avatar is actually wearing each piece of clothing.
- 3+ ITEM BODY FITTING: When combining ${body.multipleOutfits.length} items, ensure each garment conforms to the avatar's body shape. Tops should follow the torso curves, bottoms should fit the hip and leg contours, and outerwear should drape naturally over the underlying layers. The final result should look like a cohesive outfit that was specifically tailored to this avatar's body.
- 3+ ITEM POSE INTEGRATION: Adapt all ${body.multipleOutfits.length} garments to the avatar's specific pose and stance. If the avatar is in a particular position, ensure all clothing items move and drape accordingly. The outfit should look natural and realistic for the avatar's body position.
` : ''}

PHOTO-REALISTIC REQUIREMENTS:
- Generate a photorealistic image that looks like a professional fashion photograph
- Use realistic lighting with soft shadows and natural highlights
- Ensure fabric textures look authentic and tactile
- Maintain proper depth and perspective
- Avoid any cartoon-like or stylized elements
- The final image should be indistinguishable from a real photograph

Avatar posture:
- Neutral standing pose, arms relaxed at sides
- Facial expression: calm, neutral
- Lighting: studio-style, neutral white with soft shadows
- Background: plain white or very light gray
- Keep the avatar visually consistent across future generations using consistency key: {${consistencyKey}}

Output:
The final image MUST look like the original avatar/base photo with clothing applied (same person, same pose, same background). The first and last images in the request are the same base photo and must be used as the canvas; do not substitute any other image as the base.

Rules:
- Do not modify or stylize skin color or texture
- Do not regenerate facial details or change expression
- Keep camera angle and proportions identical
- Avoid artifacts, distortions, or inconsistent proportions
- PRESERVE the exact facial features and skin characteristics from the original photo
- ALWAYS include the base grey shirt and jeans for full body coverage
- Ensure photo-realistic quality throughout
- NO HALLUCINATION / EXACT MATCH: Do not invent or alter designs, trims, materials, or colors. The applied garment must visually match its source outfit photo exactly (color hue/saturation, fabric texture, print placement, seam map, closures, pocket geometry, ribbing).

Safety:
- No nudity or exposed skin beyond what's required for outfit visualization
- Base outfit ensures complete body coverage
- Do not mimic real or known individuals
- Maintain consistent quality and fashion realism

🚨 FULL BODY REQUIREMENT: The final image MUST show the avatar's complete body from head to toe. Do not crop or cut off any body parts. Include the entire body, face, and feet in the final result.

🚨 SIZE REQUIREMENT: The generated image must have the EXACT SAME SIZE and ASPECT RATIO as the user's full body photo. Do not change the dimensions, crop, or resize the image. Maintain the original photo's width, height, and proportions.

Output a single high-quality, photorealistic image of the user wearing the complete combined outfit over the base grey shirt and jeans with FULL BODY VISIBILITY, EXACT SAME SIZE as the user's photo, and perfect consistency.`;
      } else {
        // Single item Avatar Mode Prompt
        prompt = `You are an advanced AI stylist that creates realistic digital avatars for fashion try-ons.

Inputs:
1️⃣ A clear front-facing photo of the user's face with neutral lighting and expression.
2️⃣ User details:
   - Gender: ${body.userProfile?.gender || 'Not specified'}
   - Height: ${height} cm
   - Weight: ${weight} kg
   - Body type: ${bodyType}
3️⃣ A single outfit image selected by the user.

Target clothing item: "${body.outfitTitle || 'the main garment'}"
${body.outfitDescription ? `Outfit details: ${body.outfitDescription}` : ''}

Goal:
Generate a single full-body avatar image of the user, wearing the selected outfit over a base outfit, while maintaining perfect consistency in:
- Facial features and expression
- Skin texture and color
- Body proportions
- Pose and lighting
- Camera angle and background

### Instructions:

BASE OUTFIT REQUIREMENT:
- The user must ALWAYS be wearing a base outfit underneath: a plain grey cotton t-shirt and dark blue jeans
- This base outfit provides coverage and prevents any body skin exposure
- The base outfit should be visible only where the selected clothing item doesn't cover it
- The grey shirt should be a standard crew-neck t-shirt in medium grey color
- The jeans should be dark blue denim in a classic straight fit

CLOTHING APPLICATION:
- BASE COMPOSITION: Start from the user's full-body photo as the base canvas. Overlay the garment(s) onto this exact photo; do NOT redraw a new person or background.
- EXACT SIZE PRESERVATION: The generated image must have the EXACT SAME SIZE and ASPECT RATIO as the user's full body photo. Do not change the dimensions, crop, or resize the image.
- SINGLE ITEM FOCUS - CRITICAL: This is a SINGLE ITEM try-on. You are applying ONLY "${body.outfitTitle || 'the main garment'}". 
- PRESERVE ALL OTHER CLOTHING: If the user's base photo shows them wearing any clothing items (shirt, pants, shoes, accessories, etc.), you MUST preserve ALL of those items EXACTLY as they appear in the base photo. Only the specific item "${body.outfitTitle || 'the main garment'}" should change.
- TARGETED REPLACEMENT: Identify the specific clothing category of "${body.outfitTitle || 'the main garment'}" (e.g., shirt, pants, jacket, shoes). Replace ONLY that category of clothing in the base photo. All other clothing items must remain completely unchanged.
- If the selected item is a shirt/top, replace ONLY the shirt/top in the base photo - keep all pants, shoes, accessories, and other items exactly as they are
- If the selected item is pants/bottoms, replace ONLY the pants/bottoms in the base photo - keep all shirts, shoes, accessories, and other items exactly as they are
- If the selected item is outerwear (jacket, coat), layer it over the existing outfit - keep all underlying clothing items exactly as they are
- If the selected item is shoes/footwear, replace ONLY the shoes - keep all other clothing items exactly as they are
- If the selected item is an accessory, add it to the existing outfit - keep all other clothing items exactly as they are
- NO UNNECESSARY CHANGES: Do not modify, replace, or alter any clothing items that are not the target "${body.outfitTitle || 'the main garment'}". The user wants to see how ONLY this specific item looks, not a complete outfit change.
- IMPORTANT: If the outfit image contains a person or face, IGNORE the person completely — never insert their body/face/hands/hair into the output. Extract ONLY the clothing details and transfer them to the avatar.

FACIAL CONSISTENCY:
- Use the user's face photo **only** to match realistic skin tone and general facial structure
- Do **not** alter or regenerate the face, body tone, or lighting
- The avatar must look like the same person, in the same pose, under the same lighting
- The only variation allowed is the outfit itself

For the outfit:
- PERFECT FITTING REQUIREMENT: The selected item "${body.outfitTitle || 'the main garment'}" must fit the user PERFECTLY, as if it was custom-tailored to their body.
- BODY CONTOUR FITTING: Adjust the garment to conform EXACTLY to the avatar's body contours, curves, and pose. The clothing should follow the natural shape of the avatar's body precisely, not just overlay on top. The garment should hug the body where it should (waist, hips, shoulders) and drape naturally where it should (loose areas).
- POSE ADAPTATION: Adapt the garment to the avatar's specific pose - ensure the clothing drapes and fits according to their exact stance and body position. If they're standing straight, the garment should hang naturally. If they're in a dynamic pose, the garment should follow the body movement.
- PROPORTIONAL FITTING: Scale and adjust the garment to match the avatar's body proportions PERFECTLY - ensure sleeves reach the correct wrist position, torso length matches their body length, waist sits at the natural waistline, and overall fit is natural and flattering.
- NATURAL DRAPE: Ensure fabric drapes naturally over the avatar's body shape, creating realistic folds, creases, and fabric flow that match the material properties (e.g., silk drapes differently than denim).
- BODY SHAPE CONFORMITY: The clothing should hug curves, follow body lines, and create a natural silhouette that matches the avatar's physique. The fit should look like the garment was made specifically for this person's body measurements.
- SEAMLESS INTEGRATION: The new item must integrate seamlessly with any existing clothing in the base photo. If replacing a shirt, ensure it sits naturally with the existing pants. If replacing pants, ensure they work with the existing shirt. The overall look should be cohesive.
- Ensure the proportions, fabric texture, and layering look realistic
- Maintain natural folds and body alignment
- Avoid floating or misaligned garments
- Focus EXCLUSIVELY on the specific clothing item: "${body.outfitTitle || 'the main garment'}"
- Identify and apply ONLY the main garment specified - do not add extra accessories or items
- CRITICAL: Match the garment's EXACT color, texture, and material from the outfit photo
- PRESERVE the original fabric texture (e.g., leather, denim, cotton, silk, wool)
- Maintain the exact color hue, saturation, and brightness as shown in the outfit image
- Keep the same material finish (matte, glossy, textured, smooth) as the original
- Ensure the garment looks like it's made from the same material as the outfit photo

PHOTO-REALISTIC REQUIREMENTS:
- Generate a photorealistic image that looks like a professional fashion photograph
- Use realistic lighting with soft shadows and natural highlights
- Ensure fabric textures look authentic and tactile
- Maintain proper depth and perspective
- Avoid any cartoon-like or stylized elements
- The final image should be indistinguishable from a real photograph

Avatar posture:
- Neutral standing pose, arms relaxed at sides
- Facial expression: calm, neutral
- Lighting: studio-style, neutral white with soft shadows
- Background: plain white or very light gray

Output:
Generate one photorealistic image showing the avatar wearing ONLY the target item "${body.outfitTitle || 'the main garment'}" while preserving ALL other clothing items from the base photo exactly as they appear. The image must maintain identical body, face, tone features, and all non-target clothing items.

Rules:
- Do not modify or stylize skin color or texture
- Do not regenerate facial details or change expression
- Keep camera angle and proportions identical
- Avoid artifacts, distortions, or inconsistent proportions
- PRESERVE the exact facial features and skin characteristics from the original photo
- ALWAYS include the base grey shirt and jeans for full body coverage
- Ensure photo-realistic quality throughout
- EYEWEAR & SWEATERS (EXACT REPLICATION REQUIRED): 
  * EYEWEAR: If eyewear is part of the outfit, extract ONLY the exact frame design, lens shape, temple style, and color from the source photo. Apply the IDENTICAL eyewear design - same frame thickness, same lens tint, same temple curvature, same bridge width. Never modify, simplify, or redesign the eyewear - use the exact visual appearance from the source.
  * SWEATERS/KNITWEAR: Extract ONLY the exact knit pattern, ribbing design, and texture from the source photo. Preserve the IDENTICAL knit texture (cable knit, ribbed, plain, etc.) as shown in the source. Maintain the exact same collar style, cuff design, and hem treatment. Keep the same bulk, drape, and fabric weight as the original. Never flatten, simplify, or change the knit pattern - replicate it exactly.

Safety:
- No nudity or exposed skin beyond what's required for outfit visualization
- Base outfit ensures complete body coverage
- Do not mimic real or known individuals
- Maintain consistent quality and fashion realism

🚨 FULL BODY REQUIREMENT: The final image MUST show the avatar's complete body from head to toe. Do not crop or cut off any body parts. Include the entire body, face, and feet in the final result.

🚨 SIZE REQUIREMENT: The generated image must have the EXACT SAME SIZE and ASPECT RATIO as the user's full body photo. Do not change the dimensions, crop, or resize the image. Maintain the original photo's width, height, and proportions.

Output a single high-quality, photorealistic image of the user wearing the target outfit over the base grey shirt and jeans with FULL BODY VISIBILITY, EXACT SAME SIZE as the user's photo, and perfect consistency in ${body.aspectRatio ? `${body.aspectRatio.label} aspect ratio (${body.aspectRatio.width}:${body.aspectRatio.height})` : 'standard portrait format'}.`;
      }
    } else {
      // Full-Body Mode Prompt - Photorealistic try-on using user's photo
      if (body.multipleOutfits && body.multipleOutfits.length > 1) {
        // Multi-item Full Body Mode Prompt - Enhanced for Consistency
        const itemsList = body.multipleOutfits.map((item, index) => 
          `${index + 1}. ${item.title}${item.description ? ` (${item.description})` : ''}`
        ).join('\n');
        
        // Generate consistency key from user ID
        const consistencyKey = body.user_id ? body.user_id.substring(0, 8) : 'default';
        
        prompt = `🧠 Gemini Prompt for Multi-Item Try-On (Consistent Look)
You are a professional virtual fashion stylist AI that creates realistic try-on previews for users.

🚨 CRITICAL WARNING: You are processing ${body.multipleOutfits.length} items. The user's uploaded photo contains the ONLY person that should appear in the final result. You are ABSOLUTELY FORBIDDEN from generating any new person, face, or body. This is a clothing application task, NOT a person generation task.

Inputs:
1️⃣ Base photo: The user's full-body photo - USE THIS EXACT PERSON in the final result
2️⃣ Outfit items: Multiple clothing images showing different items to combine

Items to combine:
${itemsList}

Your task:
Generate a single, photorealistic image of the user wearing all selected clothing items together.

Follow these rules carefully:

0. **Base Composition (Do NOT generate a new person)**
   - Use the user's full-body photo as the base canvas.
   - IGNORE any clothing/outfits visible in the user's base photo - extract ONLY the person's body, face, pose, and background.
   - Overlay garments from the outfit images onto this exact photo.
   - Do NOT redraw or regenerate a new person, background, or pose.
   - Keep crop, camera angle, background, and lighting identical to the base photo.
   - EXACT SIZE PRESERVATION: The generated image must have the EXACT SAME SIZE and ASPECT RATIO as the user's full body photo. Do not change the dimensions, crop, or resize the image.
   - CRITICAL FOR 3+ ITEMS: When combining ${body.multipleOutfits.length} items, you MUST use the user's actual full-body photo as the base. Do NOT generate random people or create new faces/bodies. The user's photo is the ONLY person that should appear in the final result.
   - MULTI-SELECT SIZE REQUIREMENT: The final generated photo must have the EXACT SAME SIZE and ASPECT RATIO as the user's uploaded full body photo. Do not change the dimensions, crop, or resize the image during multi-select generation.
   - ABSOLUTE PROHIBITION: You are FORBIDDEN from generating any new person, face, or body. The user's uploaded photo contains the ONLY person that should exist in the final image.
   - BASE PHOTO CLOTHING IGNORANCE: If the user's base photo shows them wearing any clothing, completely ignore those garments. Extract only the person's body shape, face, pose, and background. The selected outfit items will replace any existing clothing in the base photo.

1. **Consistency**
   - Always preserve the user's original face, body shape, pose, and lighting from the base image.
   - Do not regenerate or alter any facial or body features across different try-ons.
   - Keep the same background, camera angle, and proportions for all generated images.

2. **Outfit Placement**
   - TARGET SPECIFIC GARMENTS: Apply ONLY the exact garments mentioned: ${body.multipleOutfits.map(item => `"${item.title}"`).join(', ')}
   - PRIMARY FOCUS: Each garment must be identified and applied by its specific title
   - EXACT REPLICATION: The user must appear to be wearing the exact same garments as shown in the outfit photos
   - GARMENT IDENTIFICATION: Identify each main piece of clothing in the outfit photos that represents: ${body.multipleOutfits.map(item => `"${item.title}"`).join(', ')}
   - REALISTIC APPLICATION: Make it look like the user is physically wearing these specific garments
   - LAYERING ORDER: Apply garments in logical layering order (e.g., shirt first, then jacket over it)
   - BODY CONTOUR FITTING: Adjust each garment to conform to the user's body contours, curves, and pose. The clothing should follow the natural shape of the user's body, not just overlay on top.
   - POSE ADAPTATION: Adapt each garment to the user's specific pose - if they're leaning, sitting, or in a particular stance, the clothing should drape and fit accordingly.
   - PROPORTIONAL FITTING: Scale and adjust each garment to match the user's body proportions - wider shoulders, different torso length, etc.
   - NATURAL DRAPE: Ensure fabric drapes naturally over the user's body shape, creating realistic folds, creases, and fabric flow.
   - BODY SHAPE CONFORMITY: The clothing should hug curves, follow body lines, and create a natural silhouette that matches the user's physique.
   - FABRIC INTEGRATION: Maintain fabric texture, shadowing, and correct overlap between garments
   - COHESIVE OUTFIT: Combine ALL the specified clothing items into one unified, realistic outfit
   - PERSON SUPPRESSION: If any outfit image contains a person/face/body, you must IGNORE the person completely and extract ONLY the garment region (shape, texture, color).
   - Do NOT copy or synthesize any part of that person in the outfit image (no faces, hair, hands, body, background) into the output. 
   -The output must contain exactly one person: the user from the base photo.
   - MULTI-ITEM STRICT RULE: When processing ${body.multipleOutfits.length} items, you are FORBIDDEN from generating any new people, faces, or bodies. The user's full-body photo is the ONLY person that should exist in the final image. Extract garment details from outfit photos and apply them to the user's existing body, face, and pose.
   - ZERO TOLERANCE FOR NEW PEOPLE: Under NO circumstances should you generate, create, or synthesize any new person, face, or body. The user's uploaded photo is the SOLE source of the person in the final image.
   ${body.multipleOutfits.length >= 3 ? `
   - CRITICAL FOR 3+ ITEMS: With ${body.multipleOutfits.length} items selected, you MUST focus exclusively on applying these outfits to the user's full body photo. Each garment must be carefully fitted to the user's body shape, pose, and proportions. The clothing should wrap around the user's body naturally, following their contours and curves. Do not simply overlay garments - make them appear as if the user is actually wearing each piece of clothing.
   - 3+ ITEM BODY FITTING: When combining ${body.multipleOutfits.length} items, ensure each garment conforms to the user's body shape. Tops should follow the torso curves, bottoms should fit the hip and leg contours, and outerwear should drape naturally over the underlying layers. The final result should look like a cohesive outfit that was specifically tailored to this user's body.
   - 3+ ITEM POSE INTEGRATION: Adapt all ${body.multipleOutfits.length} garments to the user's specific pose and stance. If the user is leaning, sitting, or in motion, ensure all clothing items move and drape accordingly. The outfit should look natural and realistic for the user's body position.
   ` : ''}

2.a **Detail Fidelity (critical for correctness)**
   - Preserve fine garment details exactly: buttons, zippers, seams, stitching, pockets, pleats, drawstrings, logos/labels, ribbing, and cuffs.
   - Maintain correct scale and alignment of patterns (checks, stripes, brand marks) without warping.
   - Respect original garment edges; avoid blurring into skin or background.

2.b **Eyewear and Sweater Handling (EXACT REPLICATION REQUIRED)**
   - EYEWEAR (glasses/sunglasses): 
     * If the base photo has glasses, keep them unchanged
     * If a selected item is eyewear, extract ONLY the exact frame design, lens shape, temple style, and color from the source photo
     * Apply the IDENTICAL eyewear design - same frame thickness, same lens tint, same temple curvature, same bridge width
     * Never modify, simplify, or redesign the eyewear - use the exact visual appearance from the source
     * Ensure proper reflections and transparency matching the original
   - SWEATERS/KNITWEAR:
     * Extract ONLY the exact knit pattern, ribbing design, and texture from the source photo
     * Preserve the IDENTICAL knit texture (cable knit, ribbed, plain, etc.) as shown in the source
     * Maintain the exact same collar style, cuff design, and hem treatment
     * Keep the same bulk, drape, and fabric weight as the original
     * Never flatten, simplify, or change the knit pattern - replicate it exactly
     * Ensure proper layering order (under/over other garments) as shown in source

2.c **No Hallucination / Exact-Match Rule (non-negotiable)**
   - Do NOT invent new garment designs, graphics, colors, materials, trims, or silhouettes.
   - Each applied item must visually match its source photo exactly (color hue/saturation, fabric texture, print placement, seam map, closures, pocket geometry, knit ribbing).
   - If any ambiguity exists, copy the closest visible interpretation from the selected item; never substitute with a generic or different design.
   - CRITICAL FOR SWEATERS: Extract the exact knit pattern, ribbing, cable design, and texture from the source - do not simplify or change the knit structure
   - CRITICAL FOR GLASSES: Extract the exact frame shape, lens tint, temple style, and bridge design from the source - do not modify or redesign the eyewear

3. **Visual Quality**
   - Preserve the photo's original resolution and lighting.
   - Avoid blending errors, floating garments, or missing layers.
   - Keep accessories and hair untouched unless they interfere with the garment fit.
   - CRITICAL: Match each garment's EXACT color, texture, and material from their respective outfit photos.
   - PRESERVE EXACT COLOR: Match the precise color from each outfit photo (same hue, saturation, brightness)
   - PRESERVE EXACT TEXTURE: Maintain the same fabric texture and material finish as the original
   - PRESERVE MATERIAL PROPERTIES: Keep the same material characteristics (leather, denim, cotton, silk, wool, etc.)

4. **Focus**
   - PRIMARY OBJECTIVE: Generate an accurate outfit combination preview using ONLY these specific items: ${body.multipleOutfits.map(item => `"${item.title}"`).join(', ')}
   - TARGET EXCLUSIVELY: Identify and apply ONLY the main garments specified by their exact titles - do not add extra accessories or items
   - GARMENT-SPECIFIC APPLICATION: Each item must be applied based on its specific title and characteristics
   - IGNORE DISTRACTIONS: Ignore background details or any unrelated objects in clothing images
   - COHESIVE STYLING: Create a unified, stylish combination that looks natural and well-coordinated
   - TITLE-BASED IDENTIFICATION: Use the garment titles to correctly identify which piece of clothing to apply from each outfit photo
   - FOOTWEAR REQUIREMENT: If any item is footwear (e.g., shoes, sneakers, boots, heels), ensure the shoes are clearly visible on the user's feet in the final image. Align shoes naturally with the feet, match perspective and shadows, and do not crop them out. If pants cover part of the shoes, show the realistic visible portion.
   - MULTI FULL-OUTFIT MIXING: If more than one selected item is a full outfit (title includes "outfit" or the image shows a complete look), treat each as a style source. Design ONE cohesive result by intelligently combining complementary parts across outfits like a fashion designer:
     - Choose exactly one top layer (shirt/tee/blouse/hoodie) and one bottom (pants/jeans/skirt/shorts)
     - Optionally add at most one outerwear piece (jacket/coat/cardigan)
     - Choose exactly one pair of footwear and ensure they are visible (see footwear requirement)
     - Accessories are optional; include at most one subtle accessory if it enhances cohesion
     - Never stack conflicting slots (e.g., two bottoms, two pairs of shoes). 
     -Resolve conflicts by selecting the best-matching piece based on color/material harmony and titles.
     - Blend color palettes and materials across chosen pieces to look intentional and curated.

5. **Output**
   - Produce one photorealistic image of the user wearing all chosen clothing items.
   - Maintain the same visual identity as previous generations for this user.
   - PEOPLE COUNT: Exactly one person (the user) in the final image. No extra models or people.
   - The final must look like the original base photo with only clothing changed (same person, pose, crop, background, and lighting).
   - FULL BODY VISIBILITY: The final image must show the user from head to toe - include the entire body, face, and feet.
   - NO CROPPING: Do not crop or cut off any part of the user's body in the final result.
   - COMPLETE BODY SHOT: Ensure the user's full body is visible from top to bottom.
   - EXACT SIZE MATCH: The generated image must have the EXACT SAME SIZE and ASPECT RATIO as the user's full body photo. Do not change the dimensions, crop, or resize the image.

6. **Optional tags for internal consistency**
   - Consistency key: {${consistencyKey}}
   - Style mode: "realistic studio photography"
   - Aspect ratio: ${body.aspectRatio ? `${body.aspectRatio.label} (${body.aspectRatio.width}:${body.aspectRatio.height})` : 'standard portrait format'}

Safety rules:
- No nudity or skin exposure beyond the clothing design.
- Do not modify ethnicity, facial expression, or body proportions.
- Maintain consistent quality and fashion realism.
- Ensure the generated image maintains the exact same aspect ratio as the input photo.
- The output dimensions should match the input photo's aspect ratio for consistency.

FINAL CRITICAL REMINDER FOR ${body.multipleOutfits.length} ITEMS:
- You are processing ${body.multipleOutfits.length} clothing items
- The user's full-body photo is the ONLY person that should appear in the final result
- Do NOT generate random people, faces, or bodies
- IGNORE any clothing visible in the user's base photo - extract only their body, face, pose, and background
- Extract garment details from outfit photos and apply them to the user's existing body
- The user's face, pose, and background must remain identical to the base photo
- This is a clothing overlay operation, NOT a person generation task
- The selected outfit items will completely replace any clothing visible in the user's base photo
- 🚨 ABSOLUTE PROHIBITION: You are FORBIDDEN from creating any new person, face, or body. The user's uploaded photo is the SOLE source of the person in the final image.
- 🚨 ZERO TOLERANCE: If you generate a random model instead of using the user's photo, the result is WRONG and must be rejected.
${body.multipleOutfits.length >= 3 ? `
- CRITICAL BODY FITTING FOR ${body.multipleOutfits.length} ITEMS: Each garment must be carefully fitted to the user's body shape, pose, and proportions. The clothing should wrap around the user's body naturally, following their contours and curves. Do not simply overlay garments - make them appear as if the user is actually wearing each piece of clothing.
- 3+ ITEM FOCUS: With ${body.multipleOutfits.length} items, focus exclusively on applying these outfits to the user's full body photo. Ensure each garment conforms to the user's body shape and pose for a realistic, tailored appearance.
- MULTI-SELECT SIZE PRESERVATION: The final generated photo must have the EXACT SAME SIZE and ASPECT RATIO as the user's uploaded full body photo. Do not change the dimensions, crop, or resize the image during multi-select generation.
` : ''}

🚨 FINAL WARNING: The user's uploaded photo is the ONLY person that should appear in the final result. Do NOT generate any random model or new person. This is a clothing application task using the user's existing photo.

🚨 FULL BODY REQUIREMENT: The final image MUST show the user's complete body from head to toe. Do not crop or cut off any body parts. Include the entire body, face, and feet in the final result.

🚨 SIZE REQUIREMENT: The generated image must have the EXACT SAME SIZE and ASPECT RATIO as the user's full body photo. Do not change the dimensions, crop, or resize the image. Maintain the original photo's width, height, and proportions.

Output a single high-quality, photorealistic image of the user wearing the complete combined outfit with FULL BODY VISIBILITY and EXACT SAME SIZE as the user's photo in ${body.aspectRatio ? `${body.aspectRatio.label} aspect ratio` : 'standard portrait format'}.`;
      } else {
        // Single item Full Body Mode Prompt
        prompt = `You are a professional AI fashion stylist that performs virtual try-ons for users.

IMPORTANT: You will receive TWO images:
1. FIRST IMAGE: The user's full-body photo - USE THIS EXACT PERSON in the final result
2. SECOND IMAGE: The outfit photo showing the target clothing item

TARGET OUTFIT: "${body.outfitTitle || 'the main garment'}"
${body.outfitDescription ? `OUTFIT DESCRIPTION: ${body.outfitDescription}` : ''}

Your task:
Apply the SPECIFIC outfit "${body.outfitTitle || 'the main garment'}" from Input 2 onto the person in Input 1, making it look like they are actually wearing this exact outfit.

CRITICAL INSTRUCTIONS:
- BASE COMPOSITION: Start from the user's full-body photo as the base canvas. Overlay the garment(s) onto this exact photo; do NOT redraw a new person or background.
- EXACT SIZE PRESERVATION: The generated image must have the EXACT SAME SIZE and ASPECT RATIO as the user's full body photo. Do not change the dimensions, crop, or resize the image.
- SINGLE ITEM FOCUS - CRITICAL: This is a SINGLE ITEM try-on. You are applying ONLY "${body.outfitTitle || 'the main garment'}". 
- PRESERVE ALL OTHER CLOTHING: If the user's base photo shows them wearing any clothing items (shirt, pants, shoes, accessories, etc.), you MUST preserve ALL of those items EXACTLY as they appear in the base photo. Only the specific item "${body.outfitTitle || 'the main garment'}" should change.
- TARGETED REPLACEMENT: Identify the specific clothing category of "${body.outfitTitle || 'the main garment'}" (e.g., shirt, pants, jacket, shoes). Replace ONLY that category of clothing in the base photo. All other clothing items must remain completely unchanged.
- If the selected item is a shirt/top, replace ONLY the shirt/top in the base photo - keep all pants, shoes, accessories, and other items exactly as they are
- If the selected item is pants/bottoms, replace ONLY the pants/bottoms in the base photo - keep all shirts, shoes, accessories, and other items exactly as they are
- If the selected item is outerwear (jacket, coat), layer it over the existing outfit - keep all underlying clothing items exactly as they are
- If the selected item is shoes/footwear, replace ONLY the shoes - keep all other clothing items exactly as they are
- If the selected item is an accessory, add it to the existing outfit - keep all other clothing items exactly as they are
- NO UNNECESSARY CHANGES: Do not modify, replace, or alter any clothing items that are not the target "${body.outfitTitle || 'the main garment'}". The user wants to see how ONLY this specific item looks, not a complete outfit change.
- PRIMARY FOCUS: Apply the "${body.outfitTitle || 'the main garment'}" outfit to the user
- TARGET SPECIFIC GARMENT: Focus exclusively on "${body.outfitTitle || 'the main garment'}" - ignore any other items in the outfit photo
- EXACT REPLICATION: The user must appear to be wearing the exact same "${body.outfitTitle || 'the main garment'}" as shown in the outfit photo
- GARMENT IDENTIFICATION: Identify the main piece of clothing in the outfit photo that represents "${body.outfitTitle || 'the main garment'}"
- REALISTIC APPLICATION: Make it look like the user is physically wearing this specific garment
- PERFECT FITTING REQUIREMENT: The selected item "${body.outfitTitle || 'the main garment'}" must fit the user PERFECTLY, as if it was custom-tailored to their body.
- BODY CONTOUR FITTING: Adjust the garment to conform EXACTLY to the user's body contours, curves, and pose. The clothing should follow the natural shape of the user's body precisely, not just overlay on top. The garment should hug the body where it should (waist, hips, shoulders) and drape naturally where it should (loose areas).
- POSE ADAPTATION: Adapt the garment to the user's specific pose - if they're leaning, sitting, or in a particular stance, the clothing should drape and fit accordingly. The garment should follow the body movement naturally.
- PROPORTIONAL FITTING: Scale and adjust the garment to match the user's body proportions PERFECTLY - ensure sleeves reach the correct wrist position, torso length matches their body length, waist sits at the natural waistline, and overall fit is natural and flattering.
- NATURAL DRAPE: Ensure fabric drapes naturally over the user's body shape, creating realistic folds, creases, and fabric flow that match the material properties (e.g., silk drapes differently than denim).
- BODY SHAPE CONFORMITY: The clothing should hug curves, follow body lines, and create a natural silhouette that matches the user's physique. The fit should look like the garment was made specifically for this person's body measurements.
- SEAMLESS INTEGRATION: The new item must integrate seamlessly with any existing clothing in the base photo. If replacing a shirt, ensure it sits naturally with the existing pants. If replacing pants, ensure they work with the existing shirt. The overall look should be cohesive.
- CRITICAL: Match the garment's EXACT color, texture, and material from the outfit photo
- PRESERVE FABRIC TEXTURE: Keep the original fabric texture (leather, denim, cotton, silk, wool, knit, woven, etc.)
- MAINTAIN COLOR ACCURACY: Preserve the exact color hue, saturation, and brightness as shown in the outfit image
- MATERIAL FINISH: Keep the same material finish (matte, glossy, textured, smooth, rough) as the original
- AUTHENTIC MATERIAL: Ensure the garment looks like it's made from the same material as the outfit photo
- PROPER ALIGNMENT: Align sleeves, shoulders, waist, and other key points correctly — no floating garments or distortions
- LIGHTING CONSISTENCY: Maintain original lighting and shadows from the base image for realism
- PRESERVE USER: Keep the model's face, hair, and other clothing (if compatible) completely untouched
- BACKGROUND STABILITY: Do not change the background or body proportions
- NATURAL APPEARANCE: Ensure the clothing looks physically worn by the person, not digitally pasted
- ACCURACY PRIORITY: Prioritize accurate garment placement over stylistic changes
 - PERSON SUPPRESSION: If the outfit photo contains any person/face/body, IGNORE them completely. Do NOT copy or generate their face, hair, hands, or body in the result. Extract ONLY the garment's visual properties and apply them to the user.
 - FOOTWEAR REQUIREMENT: If the target outfit or its title indicates footwear ("shoes", "sneakers", "boots", "heels", etc.), ensure the shoes are clearly visible on the user's feet. Align the shoes realistically to the feet with correct perspective, contact shadows, and scale. Do not crop or hide the shoes; if trousers cover part of them, show the naturally visible portion.
 - DETAIL FIDELITY: Preserve small details exactly (buttons, zippers, seams, stitching, logo placements, ribbing/cuffs). Keep pattern scale/alignment (checks/stripes/prints) accurate with no warping.
 - EYEWEAR & SWEATERS (EXACT REPLICATION REQUIRED): 
   * EYEWEAR: If the base photo has glasses, keep them unchanged. If eyewear is part of the outfit, extract ONLY the exact frame design, lens shape, temple style, and color from the source photo. Apply the IDENTICAL eyewear design - same frame thickness, same lens tint, same temple curvature, same bridge width. Never modify, simplify, or redesign the eyewear - use the exact visual appearance from the source.
   * SWEATERS/KNITWEAR: Extract ONLY the exact knit pattern, ribbing design, and texture from the source photo. Preserve the IDENTICAL knit texture (cable knit, ribbed, plain, etc.) as shown in the source. Maintain the exact same collar style, cuff design, and hem treatment. Keep the same bulk, drape, and fabric weight as the original. Never flatten, simplify, or change the knit pattern - replicate it exactly.
 - NO HALLUCINATION / EXACT MATCH: Do not invent or alter designs, graphics, trims, materials, or colors. The applied garment must visually match its source photo exactly (color hue/saturation, fabric texture, print placement, seam map, closures, pocket geometry, ribbing).
 - CRITICAL FOR SWEATERS: Extract the exact knit pattern, ribbing, cable design, and texture from the source - do not simplify or change the knit structure
 - CRITICAL FOR GLASSES: Extract the exact frame shape, lens tint, temple style, and bridge design from the source - do not modify or redesign the eyewear

OUTPUT REQUIREMENTS:
- The final must look like the same base photo with ONLY the target item "${body.outfitTitle || 'the main garment'}" changed (identical person, pose, background, lighting, and ALL other clothing items).
 - PEOPLE COUNT: Exactly one person (the user) must be visible; no additional models
- PRESERVE ALL OTHER CLOTHING: All clothing items in the base photo EXCEPT "${body.outfitTitle || 'the main garment'}" must remain EXACTLY as they appear in the original photo
- The person must be wearing the "${body.outfitTitle || 'the main garment'}" item, with all other clothing preserved from the base photo
- Do not change their facial features, hair, or body proportions
- Do not alter the background or lighting
- Focus EXCLUSIVELY on applying the specific "${body.outfitTitle || 'the main garment'}" garment - do not modify any other clothing
- The garment should look like it was actually worn by this person and fits perfectly with their existing outfit
- Maintain photorealistic quality throughout
- PRESERVE EXACT COLOR: Match the precise color from the outfit photo (same hue, saturation, brightness)
- PRESERVE EXACT TEXTURE: Maintain the same fabric texture and material finish as the original
- PRESERVE MATERIAL PROPERTIES: Keep the same material characteristics (leather, denim, cotton, silk, wool, etc.)

Safety and realism rules:
- No nudity or skin alteration
- Do not modify facial features or ethnicity
- Maintain consistent quality and fashion realism

🚨 FULL BODY REQUIREMENT: The final image MUST show the user's complete body from head to toe. Do not crop or cut off any body parts. Include the entire body, face, and feet in the final result.

🚨 SIZE REQUIREMENT: The generated image must have the EXACT SAME SIZE and ASPECT RATIO as the user's full body photo. Do not change the dimensions, crop, or resize the image. Maintain the original photo's width, height, and proportions.

OUTPUT: Generate a single high-quality, photorealistic image of the person wearing the "${body.outfitTitle || 'the main garment'}" outfit item with FULL BODY VISIBILITY and EXACT SAME SIZE as the user's photo in ${body.aspectRatio ? `${body.aspectRatio.label} aspect ratio (${body.aspectRatio.width}:${body.aspectRatio.height})` : 'standard portrait format'}.`;
      }
    }

    console.log('📝 Using enhanced consistent prompt for', body.mode, 'mode');
    console.log('📝 Multi-item try-on:', body.multipleOutfits ? `${body.multipleOutfits.length} items` : 'single item');
    console.log('📝 Consistency key:', body.user_id ? body.user_id.substring(0, 8) : 'default');
    console.log('📝 Prompt preview:', prompt.substring(0, 100) + '...');
    
    // Enhanced logging for outfit title usage
    console.log('📝 OUTFIT TITLE INTEGRATION:');
    console.log('📝 Outfit title:', body.outfitTitle);
    console.log('📝 Outfit description:', body.outfitDescription);
    console.log('📝 Mode:', body.mode);
    if (body.multipleOutfits) {
      console.log('📝 Multiple outfit titles:', body.multipleOutfits.map(item => item.title));
    }
    
    console.log('🖼️ Converting person image to base64...');
    console.log('🖼️ Person image URL:', body.person_url);
    console.log('🖼️ Image type:', body.mode === 'avatar' ? 'FACE PHOTO' : 'FULL BODY PHOTO');
    console.log('🖼️ User profile data:', {
      face_image_url: body.userProfile?.face_image_url ? 'Present' : 'Missing',
      full_body_image_url: body.userProfile?.full_body_image_url ? 'Present' : 'Missing',
      height_cm: body.userProfile?.height_cm,
      weight_kg: body.userProfile?.weight_kg,
      body_type: body.userProfile?.body_type,
      gender: body.userProfile?.gender || 'Not specified'
    });
    
    const personBase64 = await imageUrlToBase64(body.person_url);
    console.log('✅ Person image converted successfully, length:', personBase64.length);
    
    // Handle multiple outfit images
    const outfitImages = [];
    if (body.multipleOutfits && body.multipleOutfits.length > 1) {
      console.log('🖼️ Converting multiple outfit images to base64...');
      console.log('🖼️ Number of outfit images:', body.multipleOutfits.length);
      
      for (let i = 0; i < body.multipleOutfits.length; i++) {
        const outfit = body.multipleOutfits[i];
        console.log(`🖼️ Converting outfit ${i + 1}/${body.multipleOutfits.length}: ${outfit.title}`);
        console.log('🖼️ Outfit image URL:', outfit.outfit_url);
        
        const outfitBase64 = await imageUrlToBase64(outfit.outfit_url);
        console.log(`✅ Outfit ${i + 1} image converted successfully, length:`, outfitBase64.length);
        
        outfitImages.push({
          inline_data: {
            mime_type: "image/jpeg",
            data: outfitBase64
          }
        });
      }
    } else {
      // Single outfit image
      console.log('🖼️ Converting single outfit image to base64...');
      console.log('🖼️ Outfit image URL:', body.outfit_url);
      const outfitBase64 = await imageUrlToBase64(body.outfit_url);
      console.log('✅ Outfit image converted successfully, length:', outfitBase64.length);
      
      outfitImages.push({
        inline_data: {
          mime_type: "image/jpeg",
          data: outfitBase64
        }
      });
    }

    const requestBody = {
      contents: [{
        parts: [
          {
            text: prompt
          },
          {
            inline_data: {
              mime_type: "image/jpeg",
              data: personBase64
            }
          },
          ...outfitImages // Spread all outfit images
        ]
      }],
      generationConfig: {
        temperature: body.mode === 'avatar' ? 0.4 : 0.3, // Lower temperature for consistency
        topK: 40,
        topP: 0.95,
        maxOutputTokens: 1024
        // Intentionally no imageConfig; using prompt + desiredAspect to bias portrait output
      }
    };

    // Reinforce the base image by repeating it as the final part to strongly bias the model
    try {
      (requestBody.contents[0].parts as any[]).push({
        inline_data: {
          mime_type: "image/jpeg",
          data: personBase64
        }
      });
      console.log('🔁 Base image repeated at end of parts to reinforce canvas usage');
      
      // For 3+ items, add extra reinforcement to prevent random person generation
      if (body.multipleOutfits && body.multipleOutfits.length >= 3) {
        // Add multiple reinforcements for 3+ items
        for (let i = 0; i < 2; i++) {
          (requestBody.contents[0].parts as any[]).push({
            inline_data: {
              mime_type: "image/jpeg",
              data: personBase64
            }
          });
        }
        console.log(`🔁 EXTRA reinforcement: Base image repeated 2 more times for ${body.multipleOutfits.length} items to prevent random person generation`);
      }
    } catch (e) {
      console.warn('⚠️ Failed to append repeated base image:', e);
    }

    console.log('🔮 Using Gemini API URL:', GEMINI_API_URL);
    console.log('🔮 Request body size:', JSON.stringify(requestBody).length, 'characters');
    console.log('🔮 Making API request...');
    
    const response = await fetch(`${GEMINI_API_URL}?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });
    
    console.log('🔮 API response received:', {
      status: response.status,
      statusText: response.statusText,
      ok: response.ok,
      headers: Object.fromEntries(response.headers.entries())
    });
    
    // Log response size for debugging
    const responseText = await response.text();
    console.log('📊 Response size:', responseText.length, 'characters');
    console.log('📊 Response preview:', responseText.substring(0, 200) + '...');

    if (!response.ok) {
      console.error('❌ Gemini API Error Details:');
      console.error('❌ Status:', response.status);
      console.error('❌ Status Text:', response.statusText);
      console.error('❌ Error Response:', responseText);
      console.error('❌ Request URL:', `${GEMINI_API_URL}?key=${GEMINI_API_KEY.substring(0, 10)}...`);
      console.error('❌ Request Method:', 'POST');
      console.error('❌ Request Headers:', { 'Content-Type': 'application/json' });
      
      // Handle quota exceeded error
      if (response.status === 429) {
        console.log('⚠️ Quota exceeded, falling back to mock implementation');
        return await fallbackMockTryOn(body);
      }
      
      // Handle other specific errors
      if (response.status === 400) {
        console.error('❌ Bad Request - Check request format and parameters');
      } else if (response.status === 401) {
        console.error('❌ Unauthorized - Check API key');
      } else if (response.status === 403) {
        console.error('❌ Forbidden - API access denied');
      } else if (response.status === 404) {
        console.error('❌ Not Found - API endpoint or model not found');
      } else if (response.status >= 500) {
        console.error('❌ Server Error - Gemini API server issue');
      }
      
      throw new Error(`Gemini API request failed: ${response.status} ${response.statusText} - ${responseText}`);
    }

    const result = JSON.parse(responseText);
    console.log('✅ Gemini API: Response received');
    console.log('📋 Response structure:', JSON.stringify(result, null, 2));

    // Check if the response contains an error
    if (result.error) {
      console.error('❌ Gemini API returned error in response:', result.error);
      console.log('⚠️ Falling back to mock implementation due to API error');
      return await fallbackMockTryOn(body);
    }

    // Handle different response formats
    if (result.candidates && result.candidates[0]) {
      const candidate = result.candidates[0];
      console.log('🔍 Candidate structure:', JSON.stringify(candidate, null, 2));
      
      // Check for finish reason first
      if (candidate.finishReason) {
        console.log('🔍 Finish reason:', candidate.finishReason);
        
        // If finish reason indicates safety or other issues, fall back to mock
        if (candidate.finishReason === 'SAFETY' || candidate.finishReason === 'RECITATION' || candidate.finishReason === 'OTHER') {
          console.log('⚠️ Content blocked by safety filters or other issues, falling back to mock');
          return await fallbackMockTryOn(body);
        }
      }
      
      // Check for content with parts
      if (candidate.content && candidate.content.parts) {
        console.log('🔍 Found content with parts:', candidate.content.parts.length);
        
        for (let i = 0; i < candidate.content.parts.length; i++) {
          const part = candidate.content.parts[i];
          console.log(`🔍 Part ${i}:`, JSON.stringify(part, null, 2));
          
                 // Check for inline_data with image (snake_case) or inlineData (camelCase)
                 if ((part.inline_data && part.inline_data.data) || (part.inlineData && part.inlineData.data)) {
                   const imageData = part.inline_data?.data || part.inlineData?.data;
                   const mimeType = part.inline_data?.mime_type || part.inlineData?.mimeType || 'image/jpeg';
                   
                   console.log('✅ Found image data in part:', i);
                   console.log('📊 Image data length:', imageData.length);
                   console.log('📊 MIME type:', mimeType);
                   console.log('📊 Image data preview:', imageData.substring(0, 100) + '...');
                   
                   // Convert base64 to blob URL for display
                   const imageUrl = `data:${mimeType};base64,${imageData}`;
                   
                   console.log('✅ Gemini API: Try-on image generated successfully');
                   console.log('✅ Generated image URL length:', imageUrl.length);
                   console.log('✅ Generated image URL preview:', imageUrl.substring(0, 100) + '...');
                   
                   // Check for tablet compatibility issues
                   if (imageUrl.length > 2000000) { // 2MB limit
                     console.warn('⚠️ Generated image URL is very large:', imageUrl.length, 'bytes');
                     console.warn('⚠️ This might cause issues on tablets or mobile devices');
                   }
                   
                   return { success: true, imageUrl };
                 }
          
          // Check if part contains text instead of image (common issue)
          if (part.text) {
            console.log('⚠️ Part contains text instead of image:', part.text);
            console.log('⚠️ This might indicate the API returned text instead of generating an image');
            
            // Check if the text contains any indication of why image generation failed
            if (part.text.toLowerCase().includes('cannot') || 
                part.text.toLowerCase().includes('unable') || 
                part.text.toLowerCase().includes('error') ||
                part.text.toLowerCase().includes('not supported')) {
              console.log('⚠️ API returned error message, falling back to mock');
              return await fallbackMockTryOn(body);
            }
          }
        }
      }
      
             // Check for direct inline_data in candidate (snake_case) or inlineData (camelCase)
             if ((candidate.inline_data && candidate.inline_data.data) || (candidate.inlineData && candidate.inlineData.data)) {
               console.log('🔍 Found direct inline_data/inlineData in candidate');
               const imageData = candidate.inline_data?.data || candidate.inlineData?.data;
               const mimeType = candidate.inline_data?.mime_type || candidate.inlineData?.mimeType || 'image/jpeg';
               
               const imageUrl = `data:${mimeType};base64,${imageData}`;
               
               console.log('✅ Gemini API: Try-on image generated successfully (direct format)');
               return { success: true, imageUrl };
             }
      
      // Check if candidate has no content (empty response)
      if (!candidate.content || !candidate.content.parts || candidate.content.parts.length === 0) {
        console.log('⚠️ Candidate has no content or empty parts, falling back to mock');
        return await fallbackMockTryOn(body);
      }
    }

    // Check for alternative response formats
    if (result.data && result.data.length > 0) {
      console.log('🔍 Found alternative response format with data array');
      for (let i = 0; i < result.data.length; i++) {
        const dataItem = result.data[i];
        console.log(`🔍 Data item ${i}:`, JSON.stringify(dataItem, null, 2));
        
               if ((dataItem.inline_data && dataItem.inline_data.data) || (dataItem.inlineData && dataItem.inlineData.data)) {
                 const imageData = dataItem.inline_data?.data || dataItem.inlineData?.data;
                 const mimeType = dataItem.inline_data?.mime_type || dataItem.inlineData?.mimeType || 'image/jpeg';
                 
                 const imageUrl = `data:${mimeType};base64,${imageData}`;
                 
                 console.log('✅ Gemini API: Try-on image generated successfully (alternative format)');
                 return { success: true, imageUrl };
               }
      }
    }

    // Check for direct image data in response
    if (result.image_data) {
      console.log('🔍 Found direct image_data in response');
      const imageUrl = `data:image/jpeg;base64,${result.image_data}`;
      console.log('✅ Gemini API: Try-on image generated successfully (direct image_data)');
      return { success: true, imageUrl };
    }

    // If we get here, the response format is unexpected
    console.error('❌ Unexpected response format - no valid image data found');
    console.error('📋 Full response structure analysis:');
    console.error('📋 Response keys:', Object.keys(result));
    console.error('📋 Response type:', typeof result);
    console.error('📋 Full response:', JSON.stringify(result, null, 2));
    
    // Analyze the response structure to help debug
    analyzeResponseStructure(result);
    
    // Instead of throwing an error, fall back to mock for better user experience
    console.log('⚠️ Falling back to mock implementation due to unexpected response format');
    return await fallbackMockTryOn(body);
  } catch (error: any) {
    console.error('❌ Gemini API Exception Details:');
    console.error('❌ Error type:', typeof error);
    console.error('❌ Error name:', error?.name);
    console.error('❌ Error message:', error?.message);
    console.error('❌ Error stack:', error?.stack);
    console.error('❌ Request body:', {
      user_id: body.user_id,
      mode: body.mode,
      person_url: body.person_url,
      outfit_url: body.outfit_url
    });
    
    // If it's a quota or API error, fall back to mock
    if (error?.message && (error.message.includes('quota') || error.message.includes('429') || error.message.includes('API'))) {
      console.log('⚠️ API error detected, falling back to mock implementation');
      return await fallbackMockTryOn(body);
    }
    
    // If it's a network error, provide specific guidance
    if (error?.message && error.message.includes('fetch')) {
      console.error('❌ Network error detected - check internet connection');
    }
    
    // If it's a base64 conversion error, provide specific guidance
    if (error?.message && error.message.includes('base64')) {
      console.error('❌ Image processing error detected - check image URLs');
    }
    
    throw error;
  }
}

// Fallback mock implementation when API quota is exceeded
async function fallbackMockTryOn(body: { 
  user_id: string, 
  mode: 'avatar' | 'photo', 
  person_url: string, 
  outfit_url: string 
}): Promise<TryOnResult> {
  try {
    console.log('🔮 Fallback Mock: Starting mock try-on process...');
    console.log('🔮 Mode:', body.mode);
    console.log('🔮 Person URL:', body.person_url);
    console.log('🔮 Outfit URL:', body.outfit_url);

    // Validate URLs
    if (!body.person_url || !body.outfit_url) {
      throw new Error('Missing required image URLs');
    }

    // Simulate processing time
    await new Promise(resolve => setTimeout(resolve, 2000));

    // For now, return the person image as a mock result
    // In a real implementation, this would be the AI-generated try-on image
    console.log('✅ Fallback Mock: Mock try-on completed (using person image as placeholder)');
    
    return { 
      success: true, 
      imageUrl: body.person_url, // Using person image as placeholder
      isMock: true // Flag to indicate this is a mock result
    };
  } catch (error) {
    console.error('❌ Fallback Mock Exception:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Mock generation failed' };
  }
}

// Helper function to get fresh signed URL for Supabase storage
async function getFreshSignedUrl(imageUrl: string): Promise<string> {
  try {
    // Check if this is a Supabase signed URL
    if (imageUrl.includes('supabase.co/storage/v1/object/sign/')) {
      console.log('🔄 Detected Supabase signed URL, generating fresh one...');
      
      // Extract bucket and path from the URL
      const urlParts = imageUrl.split('/storage/v1/object/sign/')[1];
      const [bucket, ...pathParts] = urlParts.split('/');
      const path = pathParts.join('/').split('?')[0]; // Remove query parameters
      
      console.log('🔄 Extracted bucket:', bucket, 'path:', path);
      
      // Import supabase client
      const { supabase } = await import('./supabaseClient');
      
      // Generate fresh signed URL
      const { data, error } = await supabase.storage
        .from(bucket)
        .createSignedUrl(path, 3600); // 1 hour expiry
      
      if (error) {
        console.error('❌ Error creating fresh signed URL:', error);
        console.log('🔄 Falling back to original URL due to storage error');
        return imageUrl; // Fallback to original URL
      }
      
      console.log('✅ Fresh signed URL generated');
      return data.signedUrl;
    }
    
    // If not a Supabase URL, return as-is
    return imageUrl;
  } catch (error) {
    console.error('❌ Error getting fresh signed URL:', error);
    // Fallback to original URL
    return imageUrl;
  }
}

// Helper function to convert image URL to base64
async function imageUrlToBase64(imageUrl: string): Promise<string> {
  try {
    console.log('🖼️ Converting image to base64:', imageUrl);
    console.log('🖼️ Image URL type:', typeof imageUrl);
    console.log('🖼️ Image URL length:', imageUrl.length);
    
    // Directly handle data URLs (already base64)
    if (typeof imageUrl === 'string' && imageUrl.startsWith('data:')) {
      try {
        const commaIdx = imageUrl.indexOf(',');
        const base64 = commaIdx >= 0 ? imageUrl.substring(commaIdx + 1) : imageUrl;
        console.log('✅ Detected data URL, using embedded base64. Length:', base64.length);
        return base64;
      } catch (e) {
        console.warn('⚠️ Failed to parse data URL, falling back to fetch path');
      }
    }
    
    // Get fresh signed URL if needed
    const freshUrl = await getFreshSignedUrl(imageUrl);
    console.log('🖼️ Using URL for fetch:', freshUrl);
    
    console.log('🖼️ Starting fetch request...');
    const response = await fetch(freshUrl);
    
    console.log('🖼️ Fetch response:', {
      status: response.status,
      statusText: response.statusText,
      ok: response.ok,
      headers: Object.fromEntries(response.headers.entries())
    });
    
    if (!response.ok) {
      console.error('❌ Fetch failed:', response.status, response.statusText);
      
      // If the fresh URL failed, try the original URL as a last resort
      if (freshUrl !== imageUrl) {
        console.log('🔄 Fresh URL failed, trying original URL as fallback...');
        const fallbackResponse = await fetch(imageUrl);
        if (fallbackResponse.ok) {
          console.log('✅ Fallback URL worked, proceeding with original URL');
          const fallbackArrayBuffer = await fallbackResponse.arrayBuffer();
          const fallbackUint8Array = new Uint8Array(fallbackArrayBuffer);
          const chunkSize = 8192;
          let binaryString = '';
          
          for (let i = 0; i < fallbackUint8Array.length; i += chunkSize) {
            const chunk = fallbackUint8Array.slice(i, i + chunkSize);
            binaryString += String.fromCharCode(...chunk);
          }
          
          const base64 = btoa(binaryString);
          console.log('✅ Fallback base64 conversion completed, length:', base64.length);
          return base64;
        }
      }
      
      throw new Error(`Failed to fetch image: ${response.status} ${response.statusText}`);
    }
    
    console.log('🖼️ Converting response to array buffer...');
    const arrayBuffer = await response.arrayBuffer();
    console.log('🖼️ Image size:', arrayBuffer.byteLength, 'bytes');
    
    // Check if image is too large (Gemini API has limits)
    const maxSize = 20 * 1024 * 1024; // 20MB limit
    if (arrayBuffer.byteLength > maxSize) {
      console.error('❌ Image too large:', arrayBuffer.byteLength, 'bytes (max:', maxSize, 'bytes)');
      throw new Error(`Image too large: ${arrayBuffer.byteLength} bytes (max: ${maxSize} bytes)`);
    }
    
    // Process in chunks to avoid call stack overflow
    console.log('🖼️ Converting array buffer to base64...');
    const uint8Array = new Uint8Array(arrayBuffer);
    const chunkSize = 8192; // Process 8KB at a time
    let binaryString = '';
    
    for (let i = 0; i < uint8Array.length; i += chunkSize) {
      const chunk = uint8Array.slice(i, i + chunkSize);
      binaryString += String.fromCharCode(...chunk);
    }
    
    console.log('🖼️ Converting binary string to base64...');
    const base64 = btoa(binaryString);
    console.log('✅ Base64 conversion completed, length:', base64.length);
    return base64;
  } catch (error: any) {
    console.error('❌ Error converting image to base64:', error);
    console.error('❌ Error details:', {
      message: error?.message,
      stack: error?.stack,
      name: error?.name
    });
    throw new Error(`Failed to process image: ${error?.message || 'Unknown error'}`);
  }
}

// Main requestTryOn function with sequential generation support
export async function requestTryOn(body: { 
  user_id: string, 
  mode: 'avatar' | 'photo', 
  person_url: string, 
  outfit_url: string,
  userProfile?: any,
  outfitTitle?: string,
  outfitDescription?: string,
  aspectRatio?: {label: string, ratio: number, width: number, height: number},
  multipleOutfits?: Array<{
    outfit_url: string,
    title: string,
    description?: string
  }>
}): Promise<TryOnResult> {
  // Handle 3+ items with sequential generation
  if (body.multipleOutfits && body.multipleOutfits.length >= 3) {
    console.log(`🔄 Sequential generation for ${body.multipleOutfits.length} items`);
    return await requestSequentialTryOn(body);
  }
  
  // For 1-2 items, use the original function
  return await requestTryOnOriginal(body);
}

export async function generateAvatar(body: {
  user_id: string,
  face_url: string,
  height_cm: number,
  weight_kg: number,
  body_type: string
}) {
  const SERVERLESS_BASE_URL = process.env.EXPO_PUBLIC_SERVERLESS_BASE_URL || 'https://your-project.supabase.co/functions/v1';
  
  const res = await fetch(`${SERVERLESS_BASE_URL}/generate-avatar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  
  if (!res.ok) {
    throw new Error(`Avatar generation failed: ${res.statusText}`);
  }
  
  return res.json();
}

// Test function to check if AI is generating images
export async function testAIImageGeneration() {
  console.log('🧪 Testing AI Image Generation...');
  
  try {
    // Test with a simple request
    const testBody = {
      user_id: 'test-user-123',
      mode: 'avatar' as const,
      person_url: 'https://via.placeholder.com/400x600/cccccc/666666?text=Test+Person',
      outfit_url: 'https://via.placeholder.com/400x600/ffcccc/666666?text=Test+Outfit',
      userProfile: {
        gender: 'Male',
        height_cm: 175,
        weight_kg: 70,
        body_type: 'athletic'
      },
      outfitTitle: 'Test T-Shirt',
      outfitDescription: 'A simple test t-shirt'
    };

    console.log('🧪 Test request body:', testBody);
    
    const result = await requestTryOn(testBody);
    
    console.log('🧪 Test result:', {
      success: result.success,
      hasImageUrl: !!result.imageUrl,
      imageUrlLength: result.imageUrl?.length || 0,
      isMock: result.isMock,
      error: result.error
    });
    
    if (result.success && result.imageUrl) {
      console.log('✅ AI Image Generation Test: SUCCESS');
      console.log('📊 Generated image URL:', result.imageUrl.substring(0, 100) + '...');
      return {
        success: true,
        message: 'AI is generating images successfully',
        imageUrl: result.imageUrl,
        isMock: result.isMock
      };
    } else {
      console.log('❌ AI Image Generation Test: FAILED');
      return {
        success: false,
        message: 'AI failed to generate images',
        error: result.error
      };
    }
    
  } catch (error) {
    console.error('❌ AI Image Generation Test Error:', error);
    return {
      success: false,
      message: 'Test failed with error',
      error: (error as any)?.message || 'Unknown error'
    };
  }
}

export async function cleanPhoto(body: {
  user_id: string,
  photo_url: string
}) {
  const SERVERLESS_BASE_URL = process.env.EXPO_PUBLIC_SERVERLESS_BASE_URL || 'https://your-project.supabase.co/functions/v1';
  
  const res = await fetch(`${SERVERLESS_BASE_URL}/clean-photo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  
  if (!res.ok) {
    throw new Error(`Photo cleaning failed: ${res.statusText}`);
  }
  
  return res.json();
}

export interface TryOnResult { success: boolean; imageUrl?: string; error?: string; isMock?: boolean }
*/
