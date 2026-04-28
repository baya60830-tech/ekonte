import { NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";
import { z } from "zod";
import { authedClient } from "@/lib/google";
import type { Storyboard } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

const Body = z.object({
  storyboard: z.custom<Storyboard>(),
});

const HEADERS = [
  "カット番号",
  "イメージ",
  "時間（秒）",
  "累計時間",
  "シーン内容",
  "映像（撮影素材の指定）",
  "構図・カメラワーク",
  "テロップ（画面表示文言）",
  "ナレーション",
  "BGM・効果音",
  "訴求ポイント",
];

export async function POST(req: NextRequest) {
  try {
  const { storyboard } = Body.parse(await req.json());
  if (!process.env.GOOGLE_REFRESH_TOKEN) {
    return NextResponse.json({ error: "GOOGLE_REFRESH_TOKEN not set" }, { status: 500 });
  }
  const auth = authedClient();
  const drive = google.drive({ version: "v3", auth });
  const sheets = google.sheets({ version: "v4", auth });

  // 1) 新規スプシ作成
  const created = await sheets.spreadsheets.create({
    requestBody: {
      properties: { title: `絵コンテ_${storyboard.title}_${new Date().toISOString().slice(0, 10)}` },
      sheets: [{ properties: { title: "絵コンテ", gridProperties: { rowCount: storyboard.cuts.length + 5, columnCount: HEADERS.length } } }],
    },
  });
  const spreadsheetId = created.data.spreadsheetId!;
  const sheetId = created.data.sheets![0].properties!.sheetId!;

  // 2) 行データ書き込み（画像列は空。後段の /api/sheet/image で埋める）
  const values: (string | number)[][] = [HEADERS];
  storyboard.cuts.forEach((c) => {
    values.push([
      c.no,
      "",
      c.seconds,
      c.cumulative ?? "",
      c.scene,
      c.shot,
      c.camera,
      c.telop,
      c.narration,
      c.bgm,
      c.appeal,
    ]);
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: "絵コンテ!A1",
    valueInputOption: "USER_ENTERED",
    requestBody: { values },
  });

  // 4) 行高・列幅・ヘッダ装飾
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          updateDimensionProperties: {
            range: { sheetId, dimension: "ROWS", startIndex: 1, endIndex: storyboard.cuts.length + 1 },
            properties: { pixelSize: 190 },
            fields: "pixelSize",
          },
        },
        {
          updateDimensionProperties: {
            range: { sheetId, dimension: "COLUMNS", startIndex: 1, endIndex: 2 },
            properties: { pixelSize: 330 },
            fields: "pixelSize",
          },
        },
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
            cell: {
              userEnteredFormat: {
                backgroundColor: { red: 0.15, green: 0.15, blue: 0.15 },
                textFormat: { foregroundColor: { red: 1, green: 1, blue: 1 }, bold: true },
                horizontalAlignment: "CENTER",
                verticalAlignment: "MIDDLE",
              },
            },
            fields: "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment)",
          },
        },
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 1, endRowIndex: storyboard.cuts.length + 1 },
            cell: { userEnteredFormat: { verticalAlignment: "MIDDLE", wrapStrategy: "WRAP" } },
            fields: "userEnteredFormat(verticalAlignment,wrapStrategy)",
          },
        },
      ],
    },
  });

  // 5) スプシを「リンクを知っている全員が閲覧可」に
  await drive.permissions.create({
    fileId: spreadsheetId,
    requestBody: { role: "reader", type: "anyone" },
  });

    return NextResponse.json({
      spreadsheetId,
      sheetId,
      url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
    });
  } catch (e: any) {
    console.error("sheet error:", e?.response?.data ?? e);
    const detail = e?.response?.data?.error?.message ?? e?.message ?? String(e);
    return NextResponse.json({ error: detail }, { status: 500 });
  }
}
