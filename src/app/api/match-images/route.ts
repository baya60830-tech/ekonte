import Anthropic from "@anthropic-ai/sdk";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";
export const maxDuration = 120;

const Body = z.object({
  cuts: z.array(
    z.object({
      no: z.number(),
      image: z.string().optional().default(""),
      scene: z.string().optional().default(""),
      shot: z.string().optional().default(""),
      narration: z.string().optional().default(""),
    })
  ),
  thumbnails: z
    .array(z.object({ id: z.string(), dataUrl: z.string() }))
    .min(1)
    .max(20),
});

const SYSTEM = `あなたは映像編集アシスタントです。絵コンテの各カット説明と、現場で撮影された複数の写真を見比べ、各写真を最も合うカット番号にマッチさせます。
- 1枚の写真は最大1カットに紐付く（合致しなければ unused）
- 同じカットに対して複数の写真候補が出ても、最も内容が合う1枚を選ぶ
- confidence は 0〜1（1=完全合致、0.5=やや関連、0.2以下=ほぼ無関係）
- 0.4未満なら unused に入れること
- 出力は JSON のみ`;

const ResultSchema = z.object({
  assignments: z.array(
    z.object({
      thumbnailId: z.string(),
      cutNo: z.number(),
      confidence: z.number(),
      reason: z.string(),
    })
  ),
  unused: z.array(z.object({ thumbnailId: z.string(), reason: z.string() })),
});

function dataUrlParts(dataUrl: string) {
  const m = dataUrl.match(/^data:(.+?);base64,(.+)$/);
  if (!m) throw new Error("invalid data url");
  return { mediaType: m[1], data: m[2] };
}

export async function POST(req: NextRequest) {
  try {
    const { cuts, thumbnails } = Body.parse(await req.json());
    if (!process.env.ANTHROPIC_API_KEY) {
      return NextResponse.json({ error: "ANTHROPIC_API_KEY not set" }, { status: 500 });
    }
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    // 画像ブロックを構築
    const imageBlocks: Anthropic.ImageBlockParam[] = thumbnails.map((t) => {
      const { mediaType, data } = dataUrlParts(t.dataUrl);
      return {
        type: "image",
        source: { type: "base64", media_type: mediaType as any, data },
      };
    });

    // テキスト: thumbnail ID と画像の対応を明示
    const idLabel = thumbnails.map((t, i) => `画像${i + 1} = thumbnailId:"${t.id}"`).join("\n");
    const cutsText = cuts
      .map(
        (c) =>
          `カット${c.no}:\n  scene: ${c.scene}\n  shot: ${c.shot}\n  image: ${c.image}\n  narration: ${c.narration}`
      )
      .join("\n\n");

    const msg = await client.messages.create({
      model: "claude-opus-4-7",
      max_tokens: 4000,
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      messages: [
        {
          role: "user",
          content: [
            ...imageBlocks.flatMap<
              Anthropic.ImageBlockParam | Anthropic.TextBlockParam
            >((img, i) => [
              { type: "text" as const, text: `--- 画像${i + 1} ---` },
              img,
            ]),
            {
              type: "text",
              text: `\n${idLabel}\n\nカット一覧:\n${cutsText}\n\n各画像を最適なカット番号に割り当て、合うカットが無いものは unused に入れて、次のJSONで返してください。JSONのみ。\n\n{\n  "assignments": [{"thumbnailId": string, "cutNo": number, "confidence": number, "reason": string}],\n  "unused": [{"thumbnailId": string, "reason": string}]\n}`,
            },
          ],
        },
      ],
    });

    const text = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const jsonStr = text.match(/\{[\s\S]*\}/)?.[0] ?? text;
    const parsed = ResultSchema.parse(JSON.parse(jsonStr));

    return NextResponse.json(parsed);
  } catch (e: any) {
    console.error("match-images error:", e);
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
