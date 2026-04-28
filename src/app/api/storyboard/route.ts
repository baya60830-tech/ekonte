import Anthropic from "@anthropic-ai/sdk";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { Storyboard } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 120;

const Body = z.object({
  brief: z.string().min(1),
  totalSeconds: z.number().int().positive().default(60),
  cutCount: z.number().int().positive().optional(), // 未指定ならAIが決める
});

const SYSTEM = `あなたは映像ディレクターです。日本語の企画概要から、指定された総尺・カット数で絵コンテのカット表を作成します。
出力は必ず JSON のみ。各カットには以下のフィールドを含めること:
- no (1始まりの連番)
- image (画の内容を写真的に描写。被写体・場所・光・表情・服装まで具体的に。1〜2文)
- seconds (このカットの尺。合計が totalSeconds に一致するよう配分)
- scene (シーンの役割: フック / 課題提示 / 紹介 / 転換 / 解決 / CTA など)
- shot (撮影指示: 何を何処で撮るか)
- camera (構図・カメラワーク: クローズアップ/俯瞰/横移動 など)
- telop (画面に出すテロップ。不要なら空文字)
- narration (ナレーション原稿。不要なら空文字)
- bgm (BGM/SE指示)
- appeal (訴求ポイントの区分)
冒頭にフック、終盤にCTAを必ず置く。`;

export async function POST(req: NextRequest) {
  try {
    const { brief, totalSeconds, cutCount } = Body.parse(await req.json());
    if (!process.env.ANTHROPIC_API_KEY) {
      return NextResponse.json({ error: "ANTHROPIC_API_KEY not set" }, { status: 500 });
    }
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const msg = await client.messages.create({
    model: "claude-opus-4-7",
    max_tokens: 8000,
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [
      {
        role: "user",
        content: `企画概要:\n${brief}\n\n総尺: ${totalSeconds}秒\nカット数: ${cutCount ? `${cutCount}カット固定` : "尺と内容から最適なカット数をあなたが決定（目安: 1カット3〜8秒、テンポ重視なら短く、情緒重視なら長く）"}\n\n次のJSONスキーマで出力:\n{"title": string, "totalSeconds": number, "cuts": Cut[]}\nJSONのみを返答すること。`,
      },
    ],
  });

  const text = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  const jsonStr = text.match(/\{[\s\S]*\}/)?.[0] ?? text;
  const parsed = JSON.parse(jsonStr) as Storyboard;

  let acc = 0;
  parsed.cuts = parsed.cuts.map((c) => {
    acc += c.seconds;
    return { ...c, cumulative: acc };
  });

    return NextResponse.json(parsed);
  } catch (e: any) {
    console.error("storyboard error:", e);
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
