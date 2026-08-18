import { ImageResponse } from "next/og";

export const size = { width: 64, height: 64 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#101014",
          borderRadius: 18,
        }}
      >
        <div
          style={{
            display: "flex",
            fontSize: 40,
            fontWeight: 700,
            color: "#f5f5f5",
            textShadow: "0 0 18px rgba(147,197,253,0.9)",
          }}
        >
          α
        </div>
      </div>
    ),
    { ...size }
  );
}
