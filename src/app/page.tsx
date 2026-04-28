"use client";

import { useState } from "react";
import type { Storyboard } from "@/lib/types";

type Style = "photo" | "anime" | "rough";

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
    setBusy(`画像を生成中… (${targets.length}枚)`);
    try {
      const prompts = targets.map((i) => {
        const c = sb.cuts[i];
        return [c.image, c.shot, c.camera].filter(Boolean).join(" / ");
      });
      const r = await fetch("/api/images", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompts, style }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()) || "(空のレスポンス)"}`);
      const { results } = (await r.json()) as { results: { dataUrl?: string; error?: string }[] };
      const next = { ...sb, cuts: sb.cuts.slice() };
      const errs: string[] = [];
      targets.forEach((i, k) => {
        if (results[k].dataUrl) next.cuts[i] = { ...next.cuts[i], imageDataUrl: results[k].dataUrl };
        else if (results[k].error) errs.push(`カット${sb.cuts[i].no}: ${results[k].error}`);
      });
      setSb(next);
      if (errs.length) alert("画像生成エラー:\n" + errs.join("\n"));
    } catch (e: any) {
      alert(e.message);
    } finally {
      setBusy("");
    }
  }

  async function exportSheet() {
    if (!sb) return;
    setBusy("Googleスプシに出力中…");
    try {
      const r = await fetch("/api/sheet", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ storyboard: sb }),
      });
      const text = await r.text();
      if (!r.ok) {
        let msg = text || "(空のレスポンス)";
        try { msg = JSON.parse(text).error ?? msg; } catch {}
        throw new Error(`HTTP ${r.status}: ${msg}`);
      }
      const { url } = JSON.parse(text);
      setSheetUrl(url);
      window.open(url, "_blank");
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
          <div className="flex items-center gap-3">
            <h2 className="font-bold text-lg">{sb.title}（{sb.totalSeconds}秒 / {sb.cuts.length}カット）</h2>
            <button
              disabled={!!busy}
              onClick={() => generateImages()}
              className="ml-auto bg-blue-600 text-white rounded-lg px-4 py-2 disabled:opacity-50"
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
