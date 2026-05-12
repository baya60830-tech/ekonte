import { NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";
import { z } from "zod";
import { authedClient } from "@/lib/google";
import { guessMapping, parseSheetUrl, rowsToCuts } from "@/lib/column-map";
import type { Storyboard } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

const Body = z.object({
  url: z.string().trim().min(1),
});

const MAX_ROWS = 200;

async function fetchViaSheetsApi(spreadsheetId: string, gid: string) {
  if (!process.env.GOOGLE_REFRESH_TOKEN) return null;
  try {
    const auth = authedClient();
    const sheets = google.sheets({ version: "v4", auth });
    // gid から sheet name を逆引き
    const meta = await sheets.spreadsheets.get({
      spreadsheetId,
      fields: "sheets(properties(sheetId,title))",
    });
    const target = meta.data.sheets?.find(
      (s) => String(s.properties?.sheetId ?? "") === String(gid)
    );
    const sheetTitle = target?.properties?.title ?? meta.data.sheets?.[0]?.properties?.title;
    if (!sheetTitle) return null;
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetTitle}!A1:Z${MAX_ROWS}`,
    });
    return (res.data.values ?? []) as string[][];
  } catch (e: any) {
    // 権限エラーや認証切れは下流で再試行できるよう null を返す
    if (e?.code === 403 || e?.code === 404 || e?.code === 401) return null;
    throw e;
  }
}

async function fetchViaCsv(spreadsheetId: string, gid: string): Promise<string[][] | null> {
  const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=csv&gid=${gid}`;
  const r = await fetch(url, { redirect: "follow" });
  if (!r.ok) return null;
  const text = await r.text();
  // HTMLが返ってきた場合（ログイン画面リダイレクト等）は失敗扱い
  if (text.startsWith("<")) return null;
  return parseCsv(text).slice(0, MAX_ROWS);
}

// シンプルなCSVパーサ（カンマ・改行・ダブルクォート対応）
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        row.push(cur);
        cur = "";
      } else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && text[i + 1] === "\n") i++;
        row.push(cur);
        rows.push(row);
        row = [];
        cur = "";
      } else {
        cur += ch;
      }
    }
  }
  if (cur || row.length) {
    row.push(cur);
    rows.push(row);
  }
  return rows;
}

export async function POST(req: NextRequest) {
  try {
    const { url } = Body.parse(await req.json());
    const parsed = parseSheetUrl(url);
    if (!parsed) {
      return NextResponse.json(
        { error: "Google SheetsのURLとして認識できませんでした。 https://docs.google.com/spreadsheets/d/... の形式でお願いします。" },
        { status: 400 }
      );
    }
    const { spreadsheetId, gid } = parsed;

    // 1) OAuth経由を試す
    let values = await fetchViaSheetsApi(spreadsheetId, gid);
    let usedFallback = false;

    // 2) ダメならCSV公開エクスポート
    if (!values) {
      values = await fetchViaCsv(spreadsheetId, gid);
      usedFallback = !!values;
    }

    if (!values || values.length === 0) {
      return NextResponse.json(
        {
          error:
            "シートを読み取れませんでした。OAuthで権限がない場合は、シートを『リンクを知っている全員（閲覧）』に共有してください。",
        },
        { status: 403 }
      );
    }

    // ヘッダ行検出: 上から3行までで最も "意味のある" 行をヘッダとみなす
    let headerIdx = 0;
    for (let i = 0; i < Math.min(3, values.length); i++) {
      const nonEmpty = values[i].filter((v) => v && String(v).trim()).length;
      if (nonEmpty >= 3) {
        headerIdx = i;
        break;
      }
    }
    const headers = (values[headerIdx] ?? []).map((h) => String(h ?? ""));
    const dataRows = values.slice(headerIdx + 1);

    const mapping = guessMapping(headers);
    const cuts = rowsToCuts(dataRows, mapping);

    if (cuts.length === 0) {
      return NextResponse.json(
        { error: "データ行が見つかりませんでした。ヘッダ行と内容行があるか確認してください。", headers, mapping },
        { status: 422 }
      );
    }

    // 累計時間を計算
    let acc = 0;
    cuts.forEach((c) => {
      acc += Number(c.seconds) || 0;
      c.cumulative = acc;
    });

    const totalSeconds = acc;
    const storyboard: Storyboard = {
      title: "インポートした絵コンテ",
      totalSeconds,
      cuts,
    };

    return NextResponse.json({
      storyboard,
      headers,
      mapping,
      usedFallback,
      sourceUrl: url,
    });
  } catch (e: any) {
    console.error("sheet/import error:", e?.response?.data ?? e);
    const detail = e?.response?.data?.error?.message ?? e?.message ?? String(e);
    return NextResponse.json({ error: detail }, { status: 500 });
  }
}
