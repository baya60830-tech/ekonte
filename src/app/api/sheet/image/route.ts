import { NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";
import { Readable } from "node:stream";
import { z } from "zod";
import { authedClient } from "@/lib/google";

export const runtime = "nodejs";
export const maxDuration = 60;

const Body = z.object({
  spreadsheetId: z.string(),
  rowIndex: z.number().int().nonnegative(), // 0始まり、ヘッダ除く（カット番号順のインデックス）
  cutNo: z.number().int().positive(),
  dataUrl: z.string(),
});

function dataUrlToBuffer(dataUrl: string) {
  const m = dataUrl.match(/^data:(.+?);base64,(.+)$/);
  if (!m) throw new Error("invalid data url");
  return { mime: m[1], buf: Buffer.from(m[2], "base64") };
}

export async function POST(req: NextRequest) {
  try {
    const { spreadsheetId, rowIndex, cutNo, dataUrl } = Body.parse(await req.json());
    if (!process.env.GOOGLE_REFRESH_TOKEN) {
      return NextResponse.json({ error: "GOOGLE_REFRESH_TOKEN not set" }, { status: 500 });
    }
    const auth = authedClient();
    const drive = google.drive({ version: "v3", auth });
    const sheets = google.sheets({ version: "v4", auth });

    const { mime, buf } = dataUrlToBuffer(dataUrl);
    const file = await drive.files.create({
      requestBody: { name: `cut_${String(cutNo).padStart(3, "0")}.png`, mimeType: mime },
      media: { mimeType: mime, body: Readable.from(buf) },
      fields: "id",
    });
    const id = file.data.id!;
    await drive.permissions.create({ fileId: id, requestBody: { role: "reader", type: "anyone" } });
    const url = `https://drive.google.com/uc?export=view&id=${id}`;

    // B列 = 行は 1(ヘッダ) + rowIndex + 1
    const cell = `絵コンテ!B${rowIndex + 2}`;
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: cell,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[`=IMAGE("${url}",4,180,320)`]] },
    });

    return NextResponse.json({ ok: true, url });
  } catch (e: any) {
    console.error("sheet/image error:", e?.response?.data ?? e);
    const detail = e?.response?.data?.error?.message ?? e?.message ?? String(e);
    return NextResponse.json({ error: detail }, { status: 500 });
  }
}
