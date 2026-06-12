import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";
export const maxDuration = 300;

const Body = z.object({
  prompts: z.array(z.string()).min(1).max(40),
  style: z.enum(["photo", "anime", "rough"]).default("photo"),
  subjectHint: z.string().trim().max(200).optional(), // 主役属性 — 人物が登場するカットのみ注入
  allowText: z.boolean().optional().default(false),    // 画像内に文字を許可するか
  quality: z.enum(["low", "medium", "high"]).default("medium"), // gpt-image-2 の画質
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

// OpenAIのエラーを日本語の対処付きメッセージに変換
function humanizeOpenAiError(status: number, body: any): string {
  const raw = body?.error?.message ?? JSON.stringify(body ?? {});
  if (status === 401) {
    return "OPENAI_API_KEY が無効か未設定です。Vercelの環境変数を確認してください。";
  }
  if (body?.error?.code === "insufficient_quota" || /quota|billing|credit/i.test(raw)) {
    return "OpenAIの残高が不足しています。platform.openai.com → Settings → Billing でクレジットをチャージしてください。";
  }
  if (/verif/i.test(raw)) {
    return "OpenAIの組織認証が必要です。platform.openai.com/settings/organization/general で「Verify Organization」を実行してください。";
  }
  if (status === 429) {
    return `レート制限に達しました。少し待ってから再試行してください。（${raw}）`;
  }
  return raw;
}

async function generateOne(prompt: string, quality: "low" | "medium" | "high") {
  const r = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-image-2",
      prompt,
      size: "1536x864", // 16:9（gpt-image-2は16の倍数で任意解像度OK）
      quality,
      n: 1,
    }),
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) {
    return { error: humanizeOpenAiError(r.status, json) };
  }
  const b64 = json?.data?.[0]?.b64_json;
  if (!b64) return { error: "no image returned" };
  return { dataUrl: `data:image/png;base64,${b64}` };
}

export async function POST(req: NextRequest) {
  const { prompts, style, subjectHint, allowText, quality } = Body.parse(await req.json());
  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json(
      { results: prompts.map(() => ({ error: "OPENAI_API_KEY が未設定です。Vercelの環境変数に追加してください。" })) },
      { status: 200 }
    );
  }
  const subjectClause = buildSubjectClause(subjectHint);
  const textClause = allowText ? "" : NO_TEXT_CLAUSE;

  const results = await Promise.all(
    prompts.map(async (p) => {
      try {
        const includeSubject = subjectClause && mentionsPerson(p);
        const fullPrompt = [includeSubject ? subjectClause : "", p, STYLE_SUFFIX[style], textClause]
          .filter(Boolean)
          .join("\n\n");
        return await generateOne(fullPrompt, quality);
      } catch (e: any) {
        console.error("image gen error:", e);
        return { error: e?.message ?? String(e) ?? "generation failed" };
      }
    })
  );

  return NextResponse.json({ results });
}
