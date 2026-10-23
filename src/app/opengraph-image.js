import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";
export const alt = "SOUL Clinic - soulclinc.net";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export default async function SocialImage() {
  const logo = await readFile(path.join(process.cwd(), "public", "logo.PNG"));
  return new ImageResponse(
    <div style={{ width: "100%", height: "100%", background: "#172f29", color: "#ffffff", display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 24 }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={`data:image/png;base64,${logo.toString("base64")}`} alt="" width={240} height={240} style={{ objectFit: "contain" }} />
      <div style={{ fontSize: 64, display: "flex" }}>SOUL Clinic</div>
      <div style={{ fontSize: 30, color: "#e0c994", display: "flex" }}>soulclinc.net</div>
    </div>, size,
  );
}
