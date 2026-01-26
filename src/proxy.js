import { NextResponse } from "next/server";
import { verifyTokenEdge } from "./lib/jwt-edge";

export default async function proxy(req)  {
  const { pathname } = req.nextUrl;
  const token = req.cookies.get("token")?.value;


  const redirectToLoginAndClear = () => {
    const res = NextResponse.redirect(new URL("/login", req.url));
    res.cookies.delete("token");
    return res;
  };


  if (pathname === "/login" && token) {
    const payload = await verifyTokenEdge(token);

    if (!payload) {
      return redirectToLoginAndClear();
    }

    if (payload.role === "admin") {
      return NextResponse.redirect(new URL("/admin", req.url));
    }

    return NextResponse.redirect(new URL("/", req.url));
  }

  if (pathname.startsWith("/admin")) {
    if (!token) {
      return redirectToLoginAndClear();
    }

    const payload = await verifyTokenEdge(token);

    if (!payload || payload.role !== "admin") {
      return redirectToLoginAndClear();
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/admin/:path*", "/login"],
};
