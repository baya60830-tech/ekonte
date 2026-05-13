import { GoogleGenAI } from "@google/genai";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";
export const maxDuration = 300;

const Body = z.object({
  prompts: z.array(z.string()).min(1).max(40),
  style: z.enum(["photo", "anime", "rough"]).default("photo"),
  subjectHint: z.string().trim().max(200).optional(), // 主役属性 — 人物が登場するカットのみ注入
  allowText: z.boolean().optional().default(false),    // 画像内に文字を許可するか
});

const STYLE_SUFFIX: Record<string, string> = {
  photo: "Cinematic photorealistic still, 16:9, natural lighting, shallow depth of field, color-graded like a Japanese commercial.",
  anime: "Modern anime illustration, 16:9, soft cel shading, clean lineart.",
  rough: "Rough storyboard sketch, pencil on paper, monochrome, 16:9, loose lines.",
};

// 画像内の文字（特に日本語のテロップ・看板・ロゴ）を強く禁止
const NO_TEXT_CLAUSE =
  "STRICT RULE: The image MUST NOT contain any text, letters, words, captions, subtitles, signs, banners, posters, billboards, logos, brand names, or any Japanese/English characters. Plain backgrounds and signage must be blank. If a sign or screen is visible, leave it empty.";

// 日本語の主役ヒントを英語の被写体指示に変換
function buildSubjectClause(hint?: string): string {
  if (!hint) return "";
  const t = hint.trim();
  if (!t) return "";
  const female = /(女性|女子|女の子|レディ|ママ|母|お母|主婦|彼女)/.test(t);
  const male = /(男性|男子|男の子|父|お父|彼氏)/.test(t);
  let subject = "Japanese person";
  let pronoun = "their";
  if (female && !male) { subject = "Japanese woman"; pronoun = "her"; }
  else if (male && !female) { subject = "Japanese man"; pronoun = "his"; }

  const ageMatch = t.match(/(\d{2})\s*[代歳]/);
  const ageClause = ageMatch ? ` in ${pronoun} ${ageMatch[1]}s` : "";

  return `MAIN SUBJECT (mandatory): A ${subject}${ageClause}. Attribute keywords (translate to visual cues): "${t}". The main person in this image MUST match this description — gender, age, and appearance are non-negotiable.`;
}

// プロンプトに人物が含まれそうかを判定（人物カットだけにsubjectClauseを付与）
function mentionsPerson(p: string): boolean {
  return /(人|女|男|主役|社員|スタッフ|職員|保育士|先生|顧客|お客|親|子供|キャスト|モデル|笑顔|表情|手元|横顔|後ろ姿|アップ|ポートレート|man|woman|person|people|portrait|face|hand|smile)/i.test(p);
}

export async function POST(req: NextRequest) {
  const { prompts, style, subjectHint, allowText } = Body.parse(await req.json());
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const subjectClause = buildSubjectClause(subjectHint);
  const textClause = allowText ? "" : NO_TEXT_CLAUSE;

  const results = await Promise.all(
    prompts.map(async (p) => {
      try {
        const includeSubject = subjectClause && mentionsPerson(p);
        const fullPrompt = [includeSubject ? subjectClause : "", p, STYLE_SUFFIX[style], textClause]
          .filter(Boolean)
          .join("\n\n");
        const res = await ai.models.generateContent({
          model: "gemini-2.5-flash-image",
          contents: [{ role: "user", parts: [{ text: fullPrompt }] }],
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
