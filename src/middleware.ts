import { NextRequest, NextResponse } from "next/server";

const COOKIE = "ekonte_auth";

export function middleware(req: NextRequest) {
  const pw = process.env.APP_PASSWORD;
  if (!pw) return NextResponse.next(); // 未設定ならゲートなし（ローカル開発用）

  const { pathname, searchParams } = req.nextUrl;
  if (pathname.startsWith("/api/oauth")) return NextResponse.next(); // OAuthコールバックは除外

  const cookie = req.cookies.get(COOKIE)?.value;
  if (cookie === pw) return NextResponse.next();

  // ?pw=xxx で初回認証
  const tryPw = searchParams.get("pw");
  if (tryPw === pw) {
    const res = NextResponse.redirect(new URL(pathname, req.url));
    res.cookies.set(COOKIE, pw, { httpOnly: true, secure: true, sameSite: "lax", maxAge: 60 * 60 * 24 * 365 });
    return res;
  }

  return new NextResponse(
    `<html><body style="font-family:system-ui;padding:40px;max-width:400px;margin:auto"><h2>合言葉</h2><form><input name="pw" type="password" autofocus style="padding:8px;width:100%;border:1px solid #ccc;border-radius:6px"/><button style="margin-top:10px;padding:8px 16px;background:#000;color:#fff;border:0;border-radius:6px">入る</button></form></body></html>`,
    { status: 401, headers: { "content-type": "text/html; charset=utf-8" } }
  );
}

export const config = { matcher: ["/((?!_next|favicon).*)"] };
