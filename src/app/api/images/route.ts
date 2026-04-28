import { GoogleGenAI } from "@google/genai";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";
export const maxDuration = 300;

const Body = z.object({
  prompts: z.array(z.string()).min(1).max(40),
  style: z.enum(["photo", "anime", "rough"]).default("photo"),
});

const STYLE_SUFFIX: Record<string, string> = {
  photo: "Cinematic photorealistic still, 16:9, natural lighting, shallow depth of field, color-graded like a Japanese commercial.",
  anime: "Modern anime illustration, 16:9, soft cel shading, clean lineart.",
  rough: "Rough storyboard sketch, pencil on paper, monochrome, 16:9, loose lines.",
};

export async function POST(req: NextRequest) {
  const { prompts, style } = Body.parse(await req.json());
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  const results = await Promise.all(
    prompts.map(async (p) => {
      try {
        const res = await ai.models.generateContent({
          model: "gemini-2.5-flash-image",
          contents: [{ role: "user", parts: [{ text: `${p}\n\n${STYLE_SUFFIX[style]}` }] }],
        });
        const parts = res.candidates?.[0]?.content?.parts ?? [];
        const img = parts.find((pt: any) => pt.inlineData)?.inlineData;
        if (!img) return { error: "no image returned" };
        return { dataUrl: `data:${img.mimeType};base64,${img.data}` };
      } catch (e: any) {
        console.error("image gen error:", e);
        return { error: e?.message ?? String(e) ?? "generation failed" };
      }
    })
  );

  return NextResponse.json({ results });
}
