export type Cut = {
  no: number;
  image: string;          // B列: イメージ（画の説明 = 画像生成プロンプトの素）
  seconds: number;        // C列
  cumulative?: number;    // D列（自動計算）
  scene: string;          // E列: シーン内容
  shot: string;           // F列: 映像（撮影素材の指定）
  camera: string;         // G列: 構図・カメラワーク
  telop: string;          // H列: テロップ
  narration: string;      // I列: ナレーション
  bgm: string;            // J列: BGM・効果音
  appeal: string;         // K列: 訴求ポイント
  imageDataUrl?: string;  // 現在表示中の画像 (data URL)
  imageSource?: "ai" | "upload"; // 出所
  aiImageDataUrl?: string;       // 直近のAI生成画像（履歴）
  uploadImageDataUrl?: string;   // 直近のアップロード画像（履歴）
  _id?: string;                  // クライアント側の安定ID（並び替え用、出力時に除去）
};

export type Storyboard = {
  title: string;
  totalSeconds: number;
  cuts: Cut[];
};
