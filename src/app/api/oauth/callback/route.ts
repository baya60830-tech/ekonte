import { NextRequest, NextResponse } from "next/server";
import { oauthClient } from "@/lib/google";

export async function GET(req: NextRequest) {
  const code = new URL(req.url).searchParams.get("code");
  if (!code) return NextResponse.json({ error: "missing code" }, { status: 400 });
  const { tokens } = await oauthClient().getToken(code);
  return new NextResponse(
    `<pre>refresh_token を .env.local の GOOGLE_REFRESH_TOKEN に貼り付けてサーバーを再起動してください。\n\n${JSON.stringify(tokens, null, 2)}</pre>`,
    { headers: { "content-type": "text/html; charset=utf-8" } }
  );
}
