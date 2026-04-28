import "./globals.css";

export const metadata = { title: "絵コンテ自動生成", description: "Storyboard generator" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body className="bg-neutral-50 text-neutral-900 antialiased">{children}</body>
    </html>
  );
}
