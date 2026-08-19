import { NextResponse, type NextRequest } from "next/server";
import { ADMIN_COOKIE, checkPassword, isAdminConfigured, issueSession } from "@/lib/adminAuth";
import { clientIp, rateLimit } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

// Deliberately tight: this is the only endpoint where a password can be guessed.
const MAX_ATTEMPTS_PER_15_MIN = 8;

export async function POST(request: NextRequest) {
  const limited = rateLimit(`admin-login:${clientIp(request)}`, MAX_ATTEMPTS_PER_15_MIN, 15 * 60_000);
  if (!limited.ok) {
    return NextResponse.json(
      { error: "Too many attempts. Try again later." },
      { status: 429, headers: { "Retry-After": String(limited.retryAfterSeconds) } }
    );
  }

  if (!isAdminConfigured()) {
    return NextResponse.json({ error: "ADMIN_PASSWORD is not set." }, { status: 503 });
  }

  let password = "";
  try {
    const body = await request.json();
    if (typeof body?.password === "string") password = body.password;
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  if (!checkPassword(password)) {
    return NextResponse.json({ error: "Wrong password." }, { status: 401 });
  }

  const session = issueSession();
  const response = NextResponse.json({ ok: true });
  response.cookies.set(ADMIN_COOKIE, session.value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: session.maxAge,
  });
  return response;
}

export async function DELETE() {
  const response = NextResponse.json({ ok: true });
  response.cookies.set(ADMIN_COOKIE, "", { path: "/", maxAge: 0 });
  return response;
}
