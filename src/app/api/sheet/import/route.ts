import { NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";
import { z } from "zod";
import { authedClient } from "@/lib/google";
import { guessMapping, parseSheetUrl, rowsToCuts } from "@/lib/column-map";
import type { Storyboard, Cut } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

const Body = z.object({
  url: z.string().trim().min(1),
});

const MAX_ROWS = 200;
const IMAGE_FETCH_TIMEOUT_MS = 10_000;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 4MB

type Fetched = {
  values: string[][]; // 表示値
  formulas: string[][]; // 数式（=IMAGE() 等）
};

async function fetchViaSheetsApi(spreadsheetId: string, gid: string): Promise<Fetched | null> {
  if (!process.env.GOOGLE_REFRESH_TOKEN) return null;
  try {
    const auth = authedClient();
    const sheets = google.sheets({ version: "v4", auth });
    const meta = await sheets.spreadsheets.get({
      spreadsheetId,
      fields: "sheets(properties(sheetId,title))",
    });
    const target = meta.data.sheets?.find(
      (s) => String(s.properties?.sheetId ?? "") === String(gid)
    );
    const sheetTitle = target?.properties?.title ?? meta.data.sheets?.[0]?.properties?.title;
    if (!sheetTitle) return null;
    const range = `${sheetTitle}!A1:Z${MAX_ROWS}`;
    // 値と数式を並行取得
    const [vRes, fRes] = await Promise.all([
      sheets.spreadsheets.values.get({ spreadsheetId, range }),
      sheets.spreadsheets.values.get({ spreadsheetId, range, valueRenderOption: "FORMULA" }),
    ]);
    return {
      values: (vRes.data.values ?? []) as string[][],
      formulas: (fRes.data.values ?? []) as string[][],
    };
  } catch (e: any) {
    if (e?.code === 403 || e?.code === 404 || e?.code === 401) return null;
    throw e;
  }
}

async function fetchViaCsv(spreadsheetId: string, gid: string): Promise<Fetched | null> {
  const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=csv&gid=${gid}`;
  const r = await fetch(url, { redirect: "follow" });
  if (!r.ok) return null;
  const text = await r.text();
  if (text.startsWith("<")) return null;
  const rows = parseCsv(text).slice(0, MAX_ROWS);
  return { values: rows, formulas: [] }; // CSVには数式情報なし
}

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

// =IMAGE("...")式からURLを抽出
function extractImageUrlFromFormula(formula: string | undefined): string | null {
  if (!formula || typeof formula !== "string") return null;
  const m = formula.match(/^=\s*IMAGE\s*\(\s*"([^"]+)"/i);
  return m ? m[1] : null;
}

async function fetchImageAsDataUrl(url: string, drive: any): Promise<string | null> {
  try {
    // Drive のリンク (uc?id= 形式や open?id= 形式) は OAuth で取得
    const driveIdMatch = url.match(/[?&]id=([a-zA-Z0-9_-]+)/) || url.match(/\/d\/([a-zA-Z0-9_-]+)/);
    if (drive && /drive\.google\.com|googleusercontent\.com/.test(url) && driveIdMatch) {
      const id = driveIdMatch[1];
      const meta = await drive.files.get({ fileId: id, fields: "mimeType,size" });
      const size = Number(meta.data.size ?? 0);
      if (size && size > MAX_IMAGE_BYTES) return null;
      const res = await drive.files.get(
        { fileId: id, alt: "media" },
        { responseType: "arraybuffer" }
      );
      const mime = meta.data.mimeType || "image/png";
      const buf = Buffer.from(res.data as ArrayBuffer);
      if (buf.byteLength > MAX_IMAGE_BYTES) return null;
      return `data:${mime};base64,${buf.toString("base64")}`;
    }

    // 通常URL: 公開画像として fetch
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
    try {
      const r = await fetch(url, { redirect: "follow", signal: controller.signal });
      if (!r.ok) return null;
      const len = Number(r.headers.get("content-length") ?? 0);
      if (len && len > MAX_IMAGE_BYTES) return null;
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.byteLength > MAX_IMAGE_BYTES) return null;
      const mime = r.headers.get("content-type") || "image/png";
      return `data:${mime};base64,${buf.toString("base64")}`;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  try {
    const { url } = Body.parse(await req.json());
    const parsed = parseSheetUrl(url);
    if (!parsed) {
      return NextResponse.json(
        { error: "Google SheetsのURLとして認識できませんでした。" },
        { status: 400 }
      );
    }
    const { spreadsheetId, gid } = parsed;

    let fetched = await fetchViaSheetsApi(spreadsheetId, gid);
    let usedFallback = false;
    if (!fetched) {
      fetched = await fetchViaCsv(spreadsheetId, gid);
      usedFallback = !!fetched;
    }

    if (!fetched || fetched.values.length === 0) {
      return NextResponse.json(
        {
          error:
            "シートを読み取れませんでした。OAuthで権限が無い場合は、シートを『リンクを知っている全員（閲覧）』に共有してください。",
        },
        { status: 403 }
      );
    }

    const { values, formulas } = fetched;

    // ヘッダ行検出
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
    const dataFormulas = formulas.slice(headerIdx + 1);

    const mapping = guessMapping(headers);
    const cuts: Cut[] = rowsToCuts(dataRows, mapping);

    // 画像セルから =IMAGE() URL を抽出して fetch
    const imageColIdx = mapping.image; // 画像列のインデックス
    let imageImportAttempted = 0;
    let imageImportSucceeded = 0;
    let suspectInCellImage = 0;

    if (imageColIdx !== undefined && !usedFallback) {
      // OAuth 経由でのみ画像取得を試行
      const auth = authedClient();
      const drive = google.drive({ version: "v3", auth });

      // 行のフィルタは rowsToCuts と同じ条件である必要があるが簡単のため再走査
      // dataRows と cuts は順番がほぼ一致するが、空行はフィルタ済みなので index 計算に注意
      // → 元の dataRows を走査して、cuts と同じフィルタ条件を通った行だけ拾う
      const filteredFormulas: (string | undefined)[] = [];
      const filteredValues: (string | undefined)[] = [];
      dataRows.forEach((row, idx) => {
        const fields = [
          row[mapping.image ?? -1],
          row[mapping.scene ?? -1],
          row[mapping.shot ?? -1],
          row[mapping.camera ?? -1],
          row[mapping.telop ?? -1],
          row[mapping.narration ?? -1],
          row[mapping.bgm ?? -1],
          row[mapping.appeal ?? -1],
        ];
        const hasContent = fields.some((v) => v && String(v).trim());
        if (hasContent) {
          filteredFormulas.push(dataFormulas[idx]?.[imageColIdx]);
          filteredValues.push(row[imageColIdx]);
        }
      });

      // 並列 fetch（最大10並列）
      const tasks = cuts.map(async (cut, i) => {
        const formula = filteredFormulas[i];
        const value = filteredValues[i];
        const formulaUrl = extractImageUrlFromFormula(formula);
        // 値が URL らしいケースも拾う
        const directUrl =
          !formulaUrl && value && /^https?:\/\//i.test(value) ? value : null;
        const imgUrl = formulaUrl || directUrl;

        // 数式も値も無いのに「画像説明文っぽい」セル → セル内画像挿入の可能性
        if (!imgUrl && formula === undefined && (!value || !String(value).trim())) {
          suspectInCellImage++;
          return;
        }
        if (!imgUrl) return;

        imageImportAttempted++;
        const dataUrl = await fetchImageAsDataUrl(imgUrl, drive);
        if (dataUrl) {
          imageImportSucceeded++;
          cut.imageDataUrl = dataUrl;
          cut.imageSource = "upload";
          cut.uploadImageDataUrl = dataUrl;
          // image 列が URL/数式の場合、画の説明文として残すと汚いのでクリア
          if (formulaUrl || /^https?:\/\//i.test(cut.image || "")) {
            cut.image = "";
          }
        }
      });

      // 並列度を絞る
      const CONCURRENCY = 6;
      for (let i = 0; i < tasks.length; i += CONCURRENCY) {
        await Promise.all(tasks.slice(i, i + CONCURRENCY));
      }
    }

    if (cuts.length === 0) {
      return NextResponse.json(
        { error: "データ行が見つかりませんでした。", headers, mapping },
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

    const warnings: string[] = [];
    if (usedFallback) {
      warnings.push("公開リンク経由（CSV）で取り込んだため、=IMAGE() 画像は反映できませんでした。");
    }
    if (imageImportAttempted > 0 && imageImportSucceeded < imageImportAttempted) {
      warnings.push(
        `${imageImportAttempted}枚中 ${imageImportAttempted - imageImportSucceeded}枚の画像取得に失敗しました（権限・サイズ・タイムアウト）。`
      );
    }
    if (suspectInCellImage > 0) {
      warnings.push(
        `${suspectInCellImage}行の画像セルが空のまま検出されました。Google Sheetsの『セル内画像挿入』はAPIで取得できません。=IMAGE()式に置き換えるか、本ツールで撮影素材としてアップロードしてください。`
      );
    }

    return NextResponse.json({
      storyboard,
      headers,
      mapping,
      usedFallback,
      sourceUrl: url,
      imageImport: { attempted: imageImportAttempted, succeeded: imageImportSucceeded },
      warnings,
    });
  } catch (e: any) {
    console.error("sheet/import error:", e?.response?.data ?? e);
    const detail = e?.response?.data?.error?.message ?? e?.message ?? String(e);
    return NextResponse.json({ error: detail }, { status: 500 });
  }
}
