import { ImageResponse } from "next/og";

/**
 * 180px mark, same design as `icon.tsx`.
 *
 * Not just for iOS home screens: wallet extensions show the site's icon above
 * the approve/reject buttons, and Phantom picks the largest one it can find.
 * With only the 64px favicon there it rendered soft, which is exactly the wrong
 * impression on the one prompt where a user is deciding whether to trust us.
 */
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
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
        }}
      >
        <div
          style={{
            display: "flex",
            fontSize: 116,
            fontWeight: 700,
            color: "#f5f5f5",
            textShadow: "0 0 48px rgba(147,197,253,0.9)",
          }}
        >
          α
        </div>
      </div>
    ),
    { ...size }
  );
}
