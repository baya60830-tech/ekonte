"use client";

import { useEffect, useRef, useState } from "react";
import type { Storyboard, Cut } from "@/lib/types";
import { fileToOriginalDataUrl, makeThumbnail } from "@/lib/image-utils";

// 自動高さ調整 textarea
function AutoTextarea({
  value,
  onChange,
  className,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  className?: string;
  placeholder?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.max(el.scrollHeight, 60) + "px";
  }, [value]);
  return (
    <textarea
      ref={ref}
      className={className}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      rows={2}
    />
  );
}

function Field({
  label,
  value,
  onChange,
  fullWidth = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  fullWidth?: boolean;
}) {
  return (
    <label className={"block " + (fullWidth ? "col-span-2" : "")}>
      <span className="text-xs font-medium text-neutral-600">{label}</span>
      <AutoTextarea
        className="w-full text-sm border rounded p-2 mt-1"
        value={value ?? ""}
        onChange={onChange}
      />
    </label>
  );
}

function recomputeCumulative(cuts: Cut[]): Cut[] {
  let acc = 0;
  return cuts.map((c) => {
    acc += Number(c.seconds) || 0;
    return { ...c, cumulative: acc };
  });
}

type Style = "photo" | "anime" | "rough";
type Mode = "ai" | "import";

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
  const [subjectHint, setSubjectHint] = useState(""); // 主役の属性（性別・年代・服装等）
  const [style, setStyle] = useState<Style>("photo");
  const [allowText, setAllowText] = useState(false); // 画像内に文字を入れるか
  const [sb, setSb] = useState<Storyboard | null>(null);
  const [busy, setBusy] = useState<string>("");
  const [sheetUrl, setSheetUrl] = useState<string>("");
  const [pool, setPool] = useState<UploadedImage[]>([]);
  const [matchInfo, setMatchInfo] = useState<Record<number, { reason: string; confidence: number }>>({});
  const [mode, setMode] = useState<Mode>("ai");
  const [importUrl, setImportUrl] = useState("");
  const [importInfo, setImportInfo] = useState<{ headers: string[]; mapping: Record<string, number>; usedFallback: boolean } | null>(null);

  async function importFromSheet() {
    if (!importUrl.trim()) return;
    setBusy("スプシを読込中…");
    setImportInfo(null);
    try {
      const r = await fetch("/api/sheet/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: importUrl.trim() }),
      });
      const text = await r.text();
      if (!r.ok) {
        let msg = text || "(空のレスポンス)";
        try { msg = JSON.parse(text).error ?? msg; } catch {}
        throw new Error(`HTTP ${r.status}: ${msg}`);
      }
      const data = JSON.parse(text);
      const raw = data?.storyboard;
      if (!raw || !Array.isArray(raw.cuts) || raw.cuts.length === 0) {
        throw new Error("取り込んだデータにカットが見つかりません。");
      }
      // 各カットを安全にCutへ正規化
      const safeCuts: Cut[] = raw.cuts.map((c: any, idx: number) => {
        const seconds = Number(c?.seconds);
        return {
          no: Number.isFinite(Number(c?.no)) ? Number(c.no) : idx + 1,
          image: String(c?.image ?? ""),
          seconds: Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 5,
          scene: String(c?.scene ?? ""),
          shot: String(c?.shot ?? ""),
          camera: String(c?.camera ?? ""),
          telop: String(c?.telop ?? ""),
          narration: String(c?.narration ?? ""),
          bgm: String(c?.bgm ?? ""),
          appeal: String(c?.appeal ?? ""),
        };
      });
      const cuts = recomputeCumulative(safeCuts);
      const totalSeconds = cuts[cuts.length - 1]?.cumulative ?? 0;
      setSb({
        title: typeof raw.title === "string" && raw.title ? raw.title : "インポートした絵コンテ",
        totalSeconds,
        cuts,
      });
      setMatchInfo({});
      setImportInfo({ headers: data.headers ?? [], mapping: data.mapping ?? {}, usedFallback: !!data.usedFallback });
      setSheetUrl("");
    } catch (e: any) {
      alert(e.message);
    } finally {
      setBusy("");
    }
  }

  async function generateStoryboard() {
    setBusy("構成を生成中…");
    setSheetUrl("");
    try {
      const hint = subjectHint.trim();
      // 軽い確認: briefに性別関連の語があり、subjectHintが空なら一度だけ確認
      if (!hint && /(女性|男性|女子|男子|女の子|男の子|ママ|父|母|レディ)/.test(brief)) {
        const ok = confirm("企画概要に性別の語がありますが、「主役の属性」が空欄です。\n\nこのまま生成しますか？（OKで続行 / キャンセルして属性を入力）");
        if (!ok) { setBusy(""); return; }
      }
      const r = await fetch("/api/storyboard", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          brief,
          totalSeconds,
          ...(cutCount === "" ? {} : { cutCount }),
          ...(hint ? { subjectHint: hint } : {}),
        }),
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
    // 引数なし=一括 → 実写ありのカットはスキップ（上書き保護）
    // 引数あり=個別「再生成」 → 強制実行
    const isBulk = indexes === undefined;
    const candidate = indexes ?? sb.cuts.map((_, i) => i);
    const targets = isBulk
      ? candidate.filter((i) => sb.cuts[i].imageSource !== "upload")
      : candidate;
    const skipped = candidate.length - targets.length;
    if (targets.length === 0) {
      alert(skipped > 0
        ? `全カットに実写が割り当てられているのでAI生成はスキップしました。\n個別の「再生成」ボタンで強制AI生成できます。`
        : "対象カットがありません。");
      return;
    }
    const errs: string[] = [];
    let successCount = 0;
    try {
      // 1枚ずつリクエスト（Vercel 4.5MB レスポンス上限回避）
      for (let k = 0; k < targets.length; k++) {
        const i = targets[k];
        setBusy(`画像を生成中… (${k + 1}/${targets.length}${skipped > 0 ? `, 実写スキップ${skipped}件` : ""})`);
        const c = sb.cuts[i];
        const prompt = [c.image, c.shot, c.camera].filter(Boolean).join(" / ");
        try {
          const hint = subjectHint.trim();
          const r = await fetch("/api/images", {
            method: "POST",
            headers: { "content-type": "application/json" },
            cache: "no-store",
            body: JSON.stringify({
              prompts: [prompt],
              style,
              allowText,
              ...(hint ? { subjectHint: hint } : {}),
            }),
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
              cuts[i] = {
                ...cuts[i],
                imageDataUrl: res.dataUrl,
                imageSource: "ai",
                aiImageDataUrl: res.dataUrl,
              };
              return { ...prev, cuts };
            });
            successCount++;
          } else if (res?.error) {
            errs.push(`カット${c.no}: ${res.error}`);
          } else {
            // Geminiが画像を返さなかった（プロンプトが空・不適切・安全フィルタ等）
            errs.push(`カット${c.no}: 画像が返ってきませんでした。プロンプトを確認してください（「画の説明」欄に内容があるか）`);
          }
        } catch (e: any) {
          errs.push(`カット${c.no}: ${e.message}`);
        }
      }
      if (errs.length) alert("画像生成エラー:\n" + errs.join("\n"));
    } finally {
      // 個別再生成の成功時は1.5秒だけ完了メッセージを残す
      if (!isBulk && successCount > 0 && errs.length === 0) {
        setBusy(`✓ カット${sb.cuts[targets[0]].no}を再生成しました`);
        setTimeout(() => setBusy(""), 1500);
      } else {
        setBusy("");
      }
    }
  }

  async function exportSheet() {
    if (!sb) return;
    setBusy("Googleスプシに出力中…");
    try {
      // 1) スプシ作成（画像系フィールドはすべて剥がしてテキストだけ送る）
      const sbNoImg = {
        ...sb,
        cuts: sb.cuts.map(({ imageDataUrl: _a, aiImageDataUrl: _b, uploadImageDataUrl: _c, ...rest }) => rest),
      };
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
    // 秒が変わったら累計を再計算
    const nextCuts = key === "seconds" ? recomputeCumulative(cuts) : cuts;
    setSb({ ...sb, cuts: nextCuts });
  }

  function removeCut(i: number) {
    if (!sb) return;
    if (!confirm(`カット${sb.cuts[i].no}を削除しますか？`)) return;
    // 削除＆採番した新カット配列と、新旧カット番号の対応で matchInfo を再構築
    const remainingOldNos = sb.cuts.filter((_, idx) => idx !== i).map((c) => c.no);
    const cuts = sb.cuts.filter((_, idx) => idx !== i).map((c, idx) => ({ ...c, no: idx + 1 }));
    setSb({ ...sb, cuts: recomputeCumulative(cuts) });
    setMatchInfo((prev) => {
      const next: typeof prev = {};
      remainingOldNos.forEach((oldNo, idx) => {
        if (prev[oldNo]) next[idx + 1] = prev[oldNo];
      });
      return next;
    });
  }

  function addCut() {
    if (!sb) return;
    const nextNo = sb.cuts.length + 1;
    const newCut: Cut = {
      no: nextNo,
      image: "",
      seconds: 5,
      scene: "",
      shot: "",
      camera: "",
      telop: "",
      narration: "",
      bgm: "",
      appeal: "",
    };
    setSb({ ...sb, cuts: recomputeCumulative([...sb.cuts, newCut]) });
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
        next.cuts[idx] = {
          ...next.cuts[idx],
          imageDataUrl: img.originalDataUrl,
          imageSource: "upload",
          uploadImageDataUrl: img.originalDataUrl,
        };
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
    cuts[cutIndex] = {
      ...cuts[cutIndex],
      imageDataUrl: img.originalDataUrl,
      imageSource: "upload",
      uploadImageDataUrl: img.originalDataUrl,
    };
    setSb({ ...sb, cuts });
    setPool((prev) => prev.filter((p) => p.id !== thumbnailId));
  }

  function revertSource(cutIndex: number, to: "ai" | "upload") {
    if (!sb) return;
    const c = sb.cuts[cutIndex];
    const target = to === "ai" ? c.aiImageDataUrl : c.uploadImageDataUrl;
    if (!target) return;
    const cuts = sb.cuts.slice();
    cuts[cutIndex] = { ...c, imageDataUrl: target, imageSource: to };
    setSb({ ...sb, cuts });
  }

  return (
    <main className="mx-auto max-w-[1600px] p-6 space-y-6">
      <h1 className="text-2xl font-bold">絵コンテ自動生成</h1>

      {/* 入口モード切替 */}
      <div className="flex gap-2" role="tablist">
        <button
          role="tab"
          aria-selected={mode === "ai"}
          onClick={() => setMode("ai")}
          className={
            "px-4 py-2 rounded-t-lg font-medium border-b-2 " +
            (mode === "ai"
              ? "bg-white border-black"
              : "bg-neutral-100 text-neutral-500 border-transparent hover:bg-neutral-200")
          }
        >
          📝 ゼロからAIで作る
        </button>
        <button
          role="tab"
          aria-selected={mode === "import"}
          onClick={() => setMode("import")}
          className={
            "px-4 py-2 rounded-t-lg font-medium border-b-2 " +
            (mode === "import"
              ? "bg-white border-black"
              : "bg-neutral-100 text-neutral-500 border-transparent hover:bg-neutral-200")
          }
        >
          📋 既存スプシから取り込む
        </button>
      </div>

      {mode === "import" && (
        <section className="bg-white border rounded-xl p-5 space-y-3">
          <label className="block">
            <span className="text-sm font-medium">
              Google Sheets URL
              <span className="text-xs text-neutral-500 ml-2">
                （他人のシートを取り込む場合は「リンクを知っている全員（閲覧）」共有にしてください）
              </span>
            </span>
            <div className="mt-1 flex gap-2">
              <input
                type="url"
                placeholder="https://docs.google.com/spreadsheets/d/..."
                className="flex-1 border rounded-lg p-2"
                value={importUrl}
                onChange={(e) => setImportUrl(e.target.value)}
              />
              <button
                disabled={!!busy || !importUrl.trim()}
                onClick={importFromSheet}
                className="bg-black text-white rounded-lg px-4 py-2 disabled:opacity-50"
              >
                取り込む
              </button>
            </div>
          </label>
          {importInfo && (
            <div className="text-xs text-neutral-600 bg-neutral-50 border rounded p-2">
              <div>
                認識した列: {importInfo.headers.length}列 / マッピング済み:{" "}
                {Object.keys(importInfo.mapping).length}項目
                {importInfo.usedFallback && (
                  <span className="ml-2 text-amber-700">（公開リンク経由で読込）</span>
                )}
              </div>
              <details className="mt-1">
                <summary className="cursor-pointer">マッピング詳細</summary>
                <table className="mt-1 text-[11px]">
                  <tbody>
                    {Object.entries(importInfo.mapping).map(([k, idx]) => (
                      <tr key={k}>
                        <td className="pr-2 font-mono">{k}</td>
                        <td>← 列{idx + 1}: {importInfo.headers[idx]}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            </div>
          )}
        </section>
      )}

      {mode === "ai" && (
      <section className="bg-white border rounded-xl p-5 space-y-4">
        <label className="block">
          <span className="text-sm font-medium">企画概要</span>
          <textarea
            className="mt-1 w-full border rounded-lg p-2 min-h-[100px]"
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
          />
        </label>
        <label className="block">
          <span className="text-sm font-medium">
            主役の属性 <span className="text-xs text-neutral-500">(任意・性別/年代/服装/雰囲気など。AI画像生成の精度向上に使う)</span>
          </span>
          <input
            type="text"
            className="mt-1 w-full border rounded-lg p-2"
            placeholder="例: 30代女性、保育士、紺のエプロン、穏やかな笑顔"
            value={subjectHint}
            onChange={(e) => setSubjectHint(e.target.value)}
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
          <label className="flex items-center gap-2 self-end pb-2 cursor-pointer">
            <input
              type="checkbox"
              checked={allowText}
              onChange={(e) => setAllowText(e.target.checked)}
              className="w-4 h-4"
            />
            <span className="text-sm">画像内に文字OK <span className="text-xs text-neutral-500">(デフォルトは禁止)</span></span>
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
      )}

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

          {/* 凡例 */}
          <div className="flex items-center gap-3 text-xs text-neutral-700 bg-neutral-50 border rounded p-2" aria-label="画像ソースの凡例">
            <span className="font-semibold">凡例:</span>
            <span className="inline-flex items-center gap-1">
              <span className="inline-block w-4 h-4 border-4 border-violet-500 rounded-sm bg-white" aria-hidden="true" />
              <span className="bg-violet-500 text-white px-1 py-0.5 rounded">🤖 AI</span>
              <span>= AI生成画像</span>
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="inline-block w-4 h-4 border-4 border-sky-500 rounded-sm bg-white" aria-hidden="true" />
              <span className="bg-sky-500 text-white px-1 py-0.5 rounded">📷 実写</span>
              <span>= 撮影素材</span>
            </span>
          </div>

          {/* カット縦積みレイアウト */}
          <div className="space-y-4">
            {sb.cuts.map((c, i) => (
              <article key={c.no} className="border-2 rounded-xl bg-white shadow-sm overflow-hidden">
                {/* ヘッダバー */}
                <header className="flex items-center gap-3 bg-neutral-100 px-4 py-2 border-b">
                  <span className="text-lg font-bold">カット {c.no}</span>
                  <label className="text-sm flex items-center gap-1">
                    <span className="text-neutral-600">尺</span>
                    <input
                      type="number"
                      min={0}
                      step={1}
                      className="w-16 border rounded px-1 py-0.5 text-right"
                      value={c.seconds}
                      onChange={(e) => {
                        const raw = e.target.value;
                        if (raw === "") return; // 入力途中の空は無視
                        const n = parseInt(raw, 10);
                        if (Number.isFinite(n) && n >= 0) updateCut(i, "seconds", n);
                      }}
                    />
                    <span className="text-neutral-600">秒</span>
                  </label>
                  <span className="text-sm text-neutral-500">累計 {c.cumulative ?? "-"}秒</span>
                  <span className="text-sm text-neutral-500">/ シーン: <span className="text-neutral-700">{c.scene || "—"}</span></span>
                  <div className="ml-auto flex items-center gap-2">
                    <button
                      disabled={!!busy}
                      onClick={() => generateImages([i])}
                      className="text-xs bg-violet-600 hover:bg-violet-700 text-white rounded px-2 py-1 disabled:opacity-50"
                      title="このカットだけAI画像を再生成"
                    >
                      🤖 再生成
                    </button>
                    <button
                      disabled={!!busy}
                      onClick={() => removeCut(i)}
                      className="text-xs bg-neutral-300 hover:bg-red-500 hover:text-white text-neutral-700 rounded px-2 py-1 disabled:opacity-50"
                      title="このカットを削除"
                    >
                      削除
                    </button>
                  </div>
                </header>

                <div className="grid grid-cols-1 lg:grid-cols-[640px_1fr] gap-4 p-4">
                  {/* 画像エリア */}
                  <div>
                    {c.imageDataUrl ? (
                      <div className="relative">
                        <img
                          src={c.imageDataUrl}
                          className={
                            "w-full rounded border-4 " +
                            (c.imageSource === "upload"
                              ? "border-sky-500"
                              : c.imageSource === "ai"
                              ? "border-violet-500"
                              : "border-transparent")
                          }
                          alt={c.imageSource === "upload" ? "撮影素材" : c.imageSource === "ai" ? "AI生成画像" : "画像"}
                        />
                        {c.imageSource && (
                          <span
                            role="status"
                            aria-label={c.imageSource === "upload" ? "撮影素材" : "AI生成"}
                            className={
                              "absolute top-2 left-2 text-sm font-bold px-2 py-0.5 rounded shadow " +
                              (c.imageSource === "upload"
                                ? "bg-sky-500 text-white"
                                : "bg-violet-500 text-white")
                            }
                          >
                            {c.imageSource === "upload" ? "📷 実写" : "🤖 AI"}
                          </span>
                        )}
                        {((c.aiImageDataUrl && c.imageSource !== "ai") || (c.uploadImageDataUrl && c.imageSource !== "upload")) && (
                          <div className="absolute bottom-2 right-2 flex gap-1">
                            {c.aiImageDataUrl && c.imageSource !== "ai" && (
                              <button
                                onClick={() => revertSource(i, "ai")}
                                className="text-xs bg-violet-500/90 hover:bg-violet-600 text-white rounded px-2 py-1"
                              >
                                🤖に戻す
                              </button>
                            )}
                            {c.uploadImageDataUrl && c.imageSource !== "upload" && (
                              <button
                                onClick={() => revertSource(i, "upload")}
                                className="text-xs bg-sky-500/90 hover:bg-sky-600 text-white rounded px-2 py-1"
                              >
                                📷に戻す
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="w-full aspect-video bg-neutral-100 rounded flex items-center justify-center text-neutral-400 border-2 border-dashed">
                        画像なし
                      </div>
                    )}
                    {matchInfo[c.no] && (
                      <div className="mt-2 text-xs text-amber-700 bg-amber-50 rounded px-2 py-1 border border-amber-200">
                        一致度 {Math.round(matchInfo[c.no].confidence * 100)}%: {matchInfo[c.no].reason}
                      </div>
                    )}
                    {pool.length > 0 && (
                      <details className="mt-2 text-xs">
                        <summary className="cursor-pointer text-amber-700 font-medium">📁 素材プールから選ぶ ({pool.length}枚)</summary>
                        <div className="flex gap-2 flex-wrap mt-2 max-h-40 overflow-y-auto">
                          {pool.map((p) => (
                            <img
                              key={p.id}
                              src={p.thumbnailDataUrl}
                              className="w-16 h-16 object-cover rounded border cursor-pointer hover:ring-2 hover:ring-amber-500"
                              title={p.fileName}
                              onClick={() => assignFromPool(i, p.id)}
                            />
                          ))}
                        </div>
                      </details>
                    )}
                    <label className="block mt-2">
                      <span className="text-xs font-medium text-neutral-600">画の説明（AI画像生成のプロンプト）</span>
                      <AutoTextarea
                        className="w-full text-sm border rounded p-2 mt-1"
                        value={c.image}
                        onChange={(v) => updateCut(i, "image", v)}
                      />
                    </label>
                  </div>

                  {/* テキスト編集グリッド */}
                  <div className="grid grid-cols-2 gap-3 content-start">
                    <Field label="シーン" value={c.scene} onChange={(v) => updateCut(i, "scene", v)} />
                    <Field label="映像（撮影素材の指定）" value={c.shot} onChange={(v) => updateCut(i, "shot", v)} />
                    <Field label="構図・カメラワーク" value={c.camera} onChange={(v) => updateCut(i, "camera", v)} />
                    <Field label="テロップ" value={c.telop} onChange={(v) => updateCut(i, "telop", v)} />
                    <Field label="ナレーション" value={c.narration} onChange={(v) => updateCut(i, "narration", v)} fullWidth />
                    <Field label="BGM・効果音" value={c.bgm} onChange={(v) => updateCut(i, "bgm", v)} />
                    <Field label="訴求ポイント" value={c.appeal} onChange={(v) => updateCut(i, "appeal", v)} />
                  </div>
                </div>
              </article>
            ))}

            {/* カット追加ボタン */}
            <button
              disabled={!!busy}
              onClick={addCut}
              className="w-full py-3 border-2 border-dashed border-neutral-300 hover:border-neutral-500 hover:bg-neutral-50 text-neutral-500 rounded-xl text-sm disabled:opacity-50"
            >
              ＋ カットを追加
            </button>
          </div>
        </section>
      )}

      <footer className="text-xs text-neutral-500">
        初回のみ <a className="underline" href="/api/oauth/start">/api/oauth/start</a> で Google 認証 → refresh_token を .env.local に設定。
      </footer>
    </main>
  );
}
