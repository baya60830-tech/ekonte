"use client";

import { useState } from "react";
import type { Storyboard } from "@/lib/types";
import { fileToOriginalDataUrl, makeThumbnail } from "@/lib/image-utils";

type Style = "photo" | "anime" | "rough";

type UploadedImage = {
  id: string;
  fileName: string;
  thumbnailDataUrl: string;
  originalDataUrl: string;
};

export default function Page() {
  const [brief, setBrief] = useState(
    "豊田市の女性就労支援施設の採用動画。家事・育児と両立しながら働ける環境を訴求し、応募ページへ誘導する60秒。"
  );
  const [totalSeconds, setTotalSeconds] = useState(60);
  const [cutCount, setCutCount] = useState<number | "">(""); // 空ならAIが自動決定
  const [style, setStyle] = useState<Style>("photo");
  const [sb, setSb] = useState<Storyboard | null>(null);
  const [busy, setBusy] = useState<string>("");
  const [sheetUrl, setSheetUrl] = useState<string>("");
  const [pool, setPool] = useState<UploadedImage[]>([]);
  const [matchInfo, setMatchInfo] = useState<Record<number, { reason: string; confidence: number }>>({});

  async function generateStoryboard() {
    setBusy("構成を生成中…");
    setSheetUrl("");
    try {
      const r = await fetch("/api/storyboard", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ brief, totalSeconds, ...(cutCount === "" ? {} : { cutCount }) }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()) || "(空のレスポンス)"}`);
      setSb(await r.json());
    } catch (e: any) {
      alert(e.message);
    } finally {
      setBusy("");
    }
  }

  async function generateImages(indexes?: number[]) {
    if (!sb) return;
    const targets = indexes ?? sb.cuts.map((_, i) => i);
    const errs: string[] = [];
    try {
      // 1枚ずつリクエスト（Vercel 4.5MB レスポンス上限回避）
      for (let k = 0; k < targets.length; k++) {
        const i = targets[k];
        setBusy(`画像を生成中… (${k + 1}/${targets.length})`);
        const c = sb.cuts[i];
        const prompt = [c.image, c.shot, c.camera].filter(Boolean).join(" / ");
        try {
          const r = await fetch("/api/images", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ prompts: [prompt], style }),
          });
          if (!r.ok) {
            errs.push(`カット${c.no}: HTTP ${r.status}: ${(await r.text()) || "(空)"}`);
            continue;
          }
          const { results } = (await r.json()) as { results: { dataUrl?: string; error?: string }[] };
          const res = results[0];
          if (res?.dataUrl) {
            setSb((prev) => {
              if (!prev) return prev;
              const cuts = prev.cuts.slice();
              cuts[i] = { ...cuts[i], imageDataUrl: res.dataUrl };
              return { ...prev, cuts };
            });
          } else if (res?.error) {
            errs.push(`カット${c.no}: ${res.error}`);
          }
        } catch (e: any) {
          errs.push(`カット${c.no}: ${e.message}`);
        }
      }
      if (errs.length) alert("画像生成エラー:\n" + errs.join("\n"));
    } finally {
      setBusy("");
    }
  }

  async function exportSheet() {
    if (!sb) return;
    setBusy("Googleスプシに出力中…");
    try {
      // 1) スプシ作成（画像なし）
      const sbNoImg = { ...sb, cuts: sb.cuts.map(({ imageDataUrl: _omit, ...rest }) => rest) };
      const r = await fetch("/api/sheet", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ storyboard: sbNoImg }),
      });
      const text = await r.text();
      if (!r.ok) {
        let msg = text || "(空のレスポンス)";
        try { msg = JSON.parse(text).error ?? msg; } catch {}
        throw new Error(`HTTP ${r.status}: ${msg}`);
      }
      const { spreadsheetId, url } = JSON.parse(text);

      // 2) 画像を1枚ずつアップロード
      const imgErrs: string[] = [];
      for (let i = 0; i < sb.cuts.length; i++) {
        const cut = sb.cuts[i];
        if (!cut.imageDataUrl) continue;
        setBusy(`画像をスプシに反映中… (${i + 1}/${sb.cuts.length})`);
        try {
          const ir = await fetch("/api/sheet/image", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              spreadsheetId,
              rowIndex: i,
              cutNo: cut.no,
              dataUrl: cut.imageDataUrl,
            }),
          });
          if (!ir.ok) {
            const t = await ir.text();
            let m = t;
            try { m = JSON.parse(t).error ?? t; } catch {}
            imgErrs.push(`カット${cut.no}: ${m}`);
          }
        } catch (e: any) {
          imgErrs.push(`カット${cut.no}: ${e.message}`);
        }
      }

      setSheetUrl(url);
      window.open(url, "_blank");
      if (imgErrs.length) alert("一部の画像反映に失敗:\n" + imgErrs.join("\n"));
    } catch (e: any) {
      alert(e.message);
    } finally {
      setBusy("");
    }
  }

  function updateCut(i: number, key: keyof Storyboard["cuts"][number], v: string | number) {
    if (!sb) return;
    const cuts = sb.cuts.slice();
    (cuts[i] as any)[key] = v;
    setSb({ ...sb, cuts });
  }

  async function handleUpload(files: FileList | null) {
    if (!files || files.length === 0) return;
    setBusy(`画像を読み込み中… (0/${files.length})`);
    const items: UploadedImage[] = [];
    const errs: string[] = [];
    let i = 0;
    for (const f of Array.from(files)) {
      i++;
      setBusy(`画像を読み込み中… (${i}/${files.length})`);
      try {
        const original = await fileToOriginalDataUrl(f);
        const thumb = await makeThumbnail(original, 512, 0.7);
        items.push({
          id: `${Date.now()}_${i}_${Math.random().toString(36).slice(2, 8)}`,
          fileName: f.name,
          thumbnailDataUrl: thumb,
          originalDataUrl: original,
        });
      } catch (e: any) {
        errs.push(`${f.name}: ${e.message}`);
      }
    }
    setPool((prev) => [...prev, ...items]);
    setBusy("");
    if (errs.length) alert("読み込みエラー:\n" + errs.join("\n"));
  }

  function removeFromPool(id: string) {
    setPool((prev) => prev.filter((p) => p.id !== id));
  }

  function clearPool() {
    setPool([]);
    setMatchInfo({});
  }

  async function runMatch() {
    if (!sb || pool.length === 0) return;
    setBusy(`マッチング中… (${pool.length}枚)`);
    try {
      const r = await fetch("/api/match-images", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          cuts: sb.cuts.map((c) => ({
            no: c.no,
            image: c.image,
            scene: c.scene,
            shot: c.shot,
            narration: c.narration,
          })),
          thumbnails: pool.map((p) => ({ id: p.id, dataUrl: p.thumbnailDataUrl })),
        }),
      });
      if (!r.ok) {
        const t = await r.text();
        let m = t;
        try { m = JSON.parse(t).error ?? t; } catch {}
        throw new Error(`HTTP ${r.status}: ${m}`);
      }
      const { assignments } = (await r.json()) as {
        assignments: { thumbnailId: string; cutNo: number; confidence: number; reason: string }[];
        unused: { thumbnailId: string; reason: string }[];
      };

      // 同じカットに複数候補→ confidence最大を採用
      const bestPerCut = new Map<number, { thumbnailId: string; confidence: number; reason: string }>();
      for (const a of assignments) {
        const cur = bestPerCut.get(a.cutNo);
        if (!cur || a.confidence > cur.confidence) {
          bestPerCut.set(a.cutNo, a);
        }
      }
      const usedThumbnails = new Set<string>();
      const next = { ...sb, cuts: sb.cuts.slice() };
      const newInfo: Record<number, { reason: string; confidence: number }> = {};
      bestPerCut.forEach((a, cutNo) => {
        const idx = next.cuts.findIndex((c) => c.no === cutNo);
        if (idx < 0) return;
        const img = pool.find((p) => p.id === a.thumbnailId);
        if (!img) return;
        next.cuts[idx] = { ...next.cuts[idx], imageDataUrl: img.originalDataUrl };
        newInfo[cutNo] = { reason: a.reason, confidence: a.confidence };
        usedThumbnails.add(a.thumbnailId);
      });
      setSb(next);
      setMatchInfo(newInfo);
      setPool((prev) => prev.filter((p) => !usedThumbnails.has(p.id)));
    } catch (e: any) {
      alert(e.message);
    } finally {
      setBusy("");
    }
  }

  function assignFromPool(cutIndex: number, thumbnailId: string) {
    if (!sb) return;
    const img = pool.find((p) => p.id === thumbnailId);
    if (!img) return;
    const cuts = sb.cuts.slice();
    cuts[cutIndex] = { ...cuts[cutIndex], imageDataUrl: img.originalDataUrl };
    setSb({ ...sb, cuts });
    setPool((prev) => prev.filter((p) => p.id !== thumbnailId));
  }

  return (
    <main className="mx-auto max-w-7xl p-6 space-y-6">
      <h1 className="text-2xl font-bold">絵コンテ自動生成</h1>

      <section className="bg-white border rounded-xl p-5 space-y-4">
        <label className="block">
          <span className="text-sm font-medium">企画概要</span>
          <textarea
            className="mt-1 w-full border rounded-lg p-2 min-h-[100px]"
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
          />
        </label>
        <div className="flex gap-4 items-end flex-wrap">
          <label className="block">
            <span className="text-sm font-medium">総尺(秒)</span>
            <input
              type="number"
              className="mt-1 w-28 border rounded-lg p-2"
              value={totalSeconds}
              onChange={(e) => setTotalSeconds(+e.target.value)}
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium">カット数 <span className="text-xs text-neutral-500">(空欄=AI自動)</span></span>
            <input
              type="number"
              placeholder="自動"
              className="mt-1 w-28 border rounded-lg p-2"
              value={cutCount}
              onChange={(e) => setCutCount(e.target.value === "" ? "" : +e.target.value)}
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium">画風</span>
            <select
              className="mt-1 border rounded-lg p-2"
              value={style}
              onChange={(e) => setStyle(e.target.value as Style)}
            >
              <option value="photo">実写</option>
              <option value="anime">アニメ調</option>
              <option value="rough">ラフスケッチ</option>
            </select>
          </label>
          <button
            disabled={!!busy}
            onClick={generateStoryboard}
            className="ml-auto bg-black text-white rounded-lg px-4 py-2 disabled:opacity-50"
          >
            ① 構成を生成
          </button>
        </div>
      </section>

      {busy && <div className="text-sm text-blue-700">{busy}</div>}

      {sb && (
        <section className="bg-white border rounded-xl p-5 space-y-4">
          <div className="flex items-center gap-3 flex-wrap">
            <h2 className="font-bold text-lg">{sb.title}（{sb.totalSeconds}秒 / {sb.cuts.length}カット）</h2>
            <label className="ml-auto cursor-pointer bg-amber-500 hover:bg-amber-600 text-white rounded-lg px-4 py-2 disabled:opacity-50">
              📁 撮影素材をアップ
              <input
                type="file"
                accept="image/*"
                multiple
                hidden
                disabled={!!busy}
                onChange={(e) => {
                  handleUpload(e.target.files);
                  e.target.value = "";
                }}
              />
            </label>
            <button
              disabled={!!busy}
              onClick={() => generateImages()}
              className="bg-blue-600 text-white rounded-lg px-4 py-2 disabled:opacity-50"
            >
              ② 画像を一括生成
            </button>
            <button
              disabled={!!busy}
              onClick={exportSheet}
              className="bg-green-600 text-white rounded-lg px-4 py-2 disabled:opacity-50"
            >
              ③ Googleスプシに出力
            </button>
          </div>

          {pool.length > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
              <div className="flex items-center gap-3 mb-2">
                <span className="font-semibold text-sm">素材プール ({pool.length}枚)</span>
                <button
                  disabled={!!busy}
                  onClick={runMatch}
                  className="bg-amber-600 text-white rounded px-3 py-1 text-sm disabled:opacity-50"
                >
                  AIで各カットに自動振り分け
                </button>
                <button
                  disabled={!!busy}
                  onClick={clearPool}
                  className="text-xs text-neutral-600 underline"
                >
                  全消去
                </button>
                <span className="text-xs text-neutral-500 ml-auto">未使用画像はカットの「素材から」ボタンで手動配置できます</span>
              </div>
              <div className="flex gap-2 flex-wrap">
                {pool.map((p) => (
                  <div key={p.id} className="relative">
                    <img src={p.thumbnailDataUrl} className="w-24 h-24 object-cover rounded border" alt={p.fileName} />
                    <button
                      onClick={() => removeFromPool(p.id)}
                      className="absolute -top-1 -right-1 bg-red-500 text-white rounded-full w-5 h-5 text-xs leading-none"
                      title="プールから除外"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {sheetUrl && (
            <a className="text-blue-600 underline" href={sheetUrl} target="_blank">
              {sheetUrl}
            </a>
          )}

          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead className="bg-neutral-100">
                <tr>
                  {["No", "イメージ", "秒", "累計", "シーン", "映像", "構図", "テロップ", "ナレーション", "BGM/SE", "訴求", ""].map((h) => (
                    <th key={h} className="border p-2 text-left">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sb.cuts.map((c, i) => (
                  <tr key={c.no} className="align-top">
                    <td className="border p-2">{c.no}</td>
                    <td className="border p-2 w-64">
                      {c.imageDataUrl ? (
                        <img src={c.imageDataUrl} className="w-full rounded" alt="" />
                      ) : (
                        <span className="text-neutral-400">未生成</span>
                      )}
                      {matchInfo[c.no] && (
                        <div className="mt-1 text-[10px] text-amber-700 bg-amber-50 rounded px-1 py-0.5">
                          一致度 {Math.round(matchInfo[c.no].confidence * 100)}%: {matchInfo[c.no].reason}
                        </div>
                      )}
                      {pool.length > 0 && (
                        <details className="mt-1 text-xs">
                          <summary className="cursor-pointer text-amber-700">素材から選ぶ ({pool.length})</summary>
                          <div className="flex gap-1 flex-wrap mt-1">
                            {pool.map((p) => (
                              <img
                                key={p.id}
                                src={p.thumbnailDataUrl}
                                className="w-12 h-12 object-cover rounded border cursor-pointer hover:ring-2 hover:ring-amber-500"
                                title={p.fileName}
                                onClick={() => assignFromPool(i, p.id)}
                              />
                            ))}
                          </div>
                        </details>
                      )}
                      <textarea
                        className="mt-1 w-full text-xs border rounded p-1"
                        value={c.image}
                        onChange={(e) => updateCut(i, "image", e.target.value)}
                      />
                    </td>
                    <td className="border p-2 w-14">
                      <input type="number" className="w-12 border rounded p-1" value={c.seconds}
                        onChange={(e) => updateCut(i, "seconds", +e.target.value)} />
                    </td>
                    <td className="border p-2 w-14">{c.cumulative}</td>
                    {(["scene", "shot", "camera", "telop", "narration", "bgm", "appeal"] as const).map((k) => (
                      <td key={k} className="border p-2">
                        <textarea
                          className="w-40 border rounded p-1 text-xs"
                          value={(c as any)[k] ?? ""}
                          onChange={(e) => updateCut(i, k, e.target.value)}
                        />
                      </td>
                    ))}
                    <td className="border p-2">
                      <button
                        disabled={!!busy}
                        onClick={() => generateImages([i])}
                        className="text-xs bg-neutral-800 text-white rounded px-2 py-1 disabled:opacity-50"
                      >
                        再生成
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <footer className="text-xs text-neutral-500">
        初回のみ <a className="underline" href="/api/oauth/start">/api/oauth/start</a> で Google 認証 → refresh_token を .env.local に設定。
      </footer>
    </main>
  );
}
