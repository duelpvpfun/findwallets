import { ImageResponse } from "next/og";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "Alpha Wallet Finder — rank any memecoin's top traders by realized PNL";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background: "#0a0a0a",
          backgroundImage:
            "radial-gradient(circle at 50% 0%, rgba(37,99,235,0.28), transparent 55%)",
          color: "#fafafa",
          fontFamily: "sans-serif",
        }}
      >
        <div
          style={{
            display: "flex",
            fontSize: 140,
            fontWeight: 700,
            textShadow: "0 0 60px rgba(147,197,253,0.85)",
          }}
        >
          α
        </div>
        <div style={{ display: "flex", marginTop: 16, fontSize: 62, fontWeight: 700 }}>
          Alpha Wallet Finder
        </div>
        <div
          style={{
            display: "flex",
            marginTop: 18,
            fontSize: 30,
            color: "#a3a3a3",
            textAlign: "center",
            maxWidth: 880,
          }}
        >
          Rank any memecoin&apos;s top 500 traders by realized PNL — entries, exits, and exportable
          wallet lists.
        </div>
        <div style={{ display: "flex", marginTop: 36, fontSize: 24, color: "#60a5fa" }}>
          Solana · BNB Chain · Base
        </div>
      </div>
    ),
    { ...size }
  );
}
