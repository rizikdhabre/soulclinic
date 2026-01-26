import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { signToken } from "@/lib/jwt";
import { getCollection } from "@/lib/db";

export async function POST(req) {
  try {
    const { username, password } = await req.json();

    if (!username || !password) {
      return NextResponse.json(
        { message: "Missing credentials" },
        { status: 400 },
      );
    }

    const collection = await getCollection("adminLogin");

    const adminUserName = username.toLowerCase();
    const user = await collection.findOne({ username: adminUserName });
    if (!user) {
      return NextResponse.json(
        { message: "Invalid credentials" },
        { status: 401 },
      );
    }

    const isValid = await bcrypt.compare(password, user.password);

    if (!isValid) {
      return NextResponse.json(
        { message: "Invalid credentials" },
        { status: 401 },
      );
    }

    // 🔑 sign JWT
    const token = signToken({
       adminId: user._id.toString(),
      username: user.username,
      role: user.role,
    });

    const res = NextResponse.json({
      message: "Login success",
      role: user.role,
    });

    // 🍪 set cookie
    res.cookies.set("token", token, {
      httpOnly: true,
      secure: false, // set true in production (https)
      sameSite: "lax",
      path: "/",
    });

    return res;
  } catch (error) {
    console.error("Login error:", error);
    return NextResponse.json({ message: "Server error" }, { status: 500 });
  }
}
