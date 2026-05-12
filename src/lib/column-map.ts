import type { Cut } from "./types";

// 表記揺れを吸収するエイリアス辞書
const ALIASES: Partial<Record<keyof Cut, RegExp[]>> = {
  no: [/^カット番号$/, /^カット$/, /^no\.?$/i, /^番号$/, /^cut$/i, /^#$/, /^connumber$/i],
  image: [/^イメージ$/, /^画像$/, /^画$/, /^image$/i, /^visual$/i, /^ビジュアル$/, /^picture$/i, /^写真$/, /^絵$/],
  seconds: [/^秒$/, /^尺$/, /^時間.?秒.?$/, /^seconds?$/i, /^duration$/i, /^sec$/i, /^len$/i, /^時間$/],
  cumulative: [/^累計/, /^累積/, /^cum/i, /^total/i],
  scene: [/^シーン/, /^scene/i, /^内容$/, /^description$/i, /^見出し$/, /^section/i],
  shot: [/^映像/, /^撮影/, /^shot/i, /^素材/, /^クリップ/, /^footage/i],
  camera: [/^構図/, /^カメラ/, /^camera/i, /^framing/i, /^アングル/],
  telop: [/^テロップ/, /^字幕/, /^telop/i, /^caption/i, /^subtitle/i, /^画面表示/, /^文言/],
  narration: [/^ナレ/, /^narrat/i, /^voice/i, /^台詞/, /^セリフ/, /^vo$/i, /^na$/i, /^読み/],
  bgm: [/^bgm/i, /^se$/i, /^効果音/, /^音/, /^sound/i, /^audio/i],
  appeal: [/^訴求/, /^pr$/i, /^appeal/i, /^ポイント/, /^point/i, /^狙い/, /^key/i],
};

// 正規化: trim → 全角→半角 → 小文字 → 記号除去
function normalize(s: string): string {
  return s
    .trim()
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[（）()【】「」\[\]\.,，、・:：;；／\/]/g, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

export type GuessedMapping = Partial<Record<keyof Cut, number>>;

/**
 * ヘッダ配列から各フィールドの列インデックスを推測
 */
export function guessMapping(headers: string[]): GuessedMapping {
  const result: GuessedMapping = {};
  const normalized = headers.map(normalize);
  for (const [field, patterns] of Object.entries(ALIASES) as [keyof Cut, RegExp[]][]) {
    for (let i = 0; i < normalized.length; i++) {
      if (result[field] !== undefined) break;
      const h = normalized[i];
      if (!h) continue;
      if (patterns.some((p) => p.test(h))) {
        result[field] = i;
        break;
      }
    }
  }
  return result;
}

/**
 * 2次元配列 + マッピング → Cut[]
 * ヘッダ行はスキップ済みの想定（dataRows のみ渡す）
 */
export function rowsToCuts(dataRows: string[][], mapping: GuessedMapping): Cut[] {
  return dataRows
    .map((row, idx) => {
      const get = (k: keyof Cut): string => {
        const col = mapping[k];
        if (col === undefined) return "";
        return (row[col] ?? "").toString().trim();
      };
      const rawNo = get("no");
      const no = parseInt(rawNo, 10);
      const seconds = parseInt(get("seconds"), 10);
      return {
        no: isNaN(no) ? idx + 1 : no,
        image: get("image"),
        seconds: isNaN(seconds) ? 5 : seconds,
        cumulative: undefined,
        scene: get("scene"),
        shot: get("shot"),
        camera: get("camera"),
        telop: get("telop"),
        narration: get("narration"),
        bgm: get("bgm"),
        appeal: get("appeal"),
      } as Cut;
    })
    // 全フィールドが空の行は除外
    .filter((c) =>
      [c.image, c.scene, c.shot, c.camera, c.telop, c.narration, c.bgm, c.appeal].some((v) => v && v.trim())
    );
}

/**
 * Google Sheets URL から spreadsheetId と gid を抽出
 */
export function parseSheetUrl(url: string): { spreadsheetId: string; gid: string } | null {
  const m = url.match(/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (!m) return null;
  const gidMatch = url.match(/[?#&]gid=(\d+)/);
  return { spreadsheetId: m[1], gid: gidMatch ? gidMatch[1] : "0" };
}
