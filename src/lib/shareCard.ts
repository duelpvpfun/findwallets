import { formatUsd, shortenAddress } from "./format";

/** Browser-only canvas drawing for the shareable PNL card. Never import this
 * from a server component/route — it touches `Image`/`HTMLCanvasElement`. */

export interface ShareCardData {
  symbol: string;
  walletAddress: string;
  pnlUsd: number;
  pnlPercent: number;
  multipleX: number;
  investedUsd: number;
  positionUsd: number;
  siteHost: string;
}

export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 800;

const BACKGROUNDS = ["/pnl-bg/bg-1.svg", "/pnl-bg/bg-2.svg", "/pnl-bg/bg-3.svg"];

/** Deterministic so the same wallet always renders on the same background
 * instead of flickering between choices on repeat generations. */
export function pickBackground(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return BACKGROUNDS[hash % BACKGROUNDS.length];
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load ${src}`));
    img.src = src;
  });
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Draws a pill at `x`, vertically centered on `yCenter`, and returns its width
 * so the caller can chain the next pill right after it. */
function drawPill(
  ctx: CanvasRenderingContext2D,
  x: number,
  yCenter: number,
  text: string,
  textColor: string,
  bgColor: string
): number {
  ctx.font = "700 26px Arial, sans-serif";
  const paddingX = 18;
  const height = 42;
  const width = ctx.measureText(text).width + paddingX * 2;
  roundRect(ctx, x, yCenter - height / 2, width, height, height / 2);
  ctx.fillStyle = bgColor;
  ctx.fill();
  ctx.fillStyle = textColor;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x + paddingX, yCenter + 1);
  return width;
}

function drawStatRow(
  ctx: CanvasRenderingContext2D,
  xLeft: number,
  xRight: number,
  y: number,
  label: string,
  value: string
) {
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#a3a3a3";
  ctx.font = "500 24px Arial, sans-serif";
  ctx.fillText(label, xLeft, y);
  ctx.textAlign = "right";
  ctx.fillStyle = "#fafafa";
  ctx.font = "700 28px Arial, sans-serif";
  ctx.fillText(value, xRight, y);
  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(xLeft, y + 28);
  ctx.lineTo(xRight, y + 28);
  ctx.stroke();
}

export async function drawPnlCard(canvas: HTMLCanvasElement, data: ShareCardData): Promise<void> {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is not supported in this browser.");
  const W = (canvas.width = CARD_WIDTH);
  const H = (canvas.height = CARD_HEIGHT);
  const pad = 56;

  const bg = await loadImage(pickBackground(data.walletAddress));
  ctx.drawImage(bg, 0, 0, W, H);

  // Flat dark overlay so white text stays legible regardless of the
  // underlying background's own contrast.
  ctx.fillStyle = "rgba(0,0,0,0.4)";
  ctx.fillRect(0, 0, W, H);

  const positive = data.pnlUsd >= 0;
  const accent = positive ? "#34d399" : "#fb7185";
  const accentDark = positive ? "#052e1c" : "#450a0a";

  // Logo mark, top-left.
  ctx.fillStyle = "#f5f5f5";
  roundRect(ctx, pad, 48, 56, 56, 14);
  ctx.fill();
  ctx.fillStyle = "#2563eb";
  ctx.beginPath();
  ctx.moveTo(pad + 28, 62);
  ctx.lineTo(pad + 46, 92);
  ctx.lineTo(pad + 10, 92);
  ctx.closePath();
  ctx.fill();

  // Brand, top-right.
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#fafafa";
  ctx.font = "700 32px Arial, sans-serif";
  ctx.fillText("AlphaWallets", W - pad, 76);

  // Coin tag.
  ctx.textAlign = "left";
  ctx.fillStyle = "#e5e5e5";
  ctx.font = "700 42px Arial, sans-serif";
  ctx.fillText(`$${data.symbol.toUpperCase()}`, pad, 176);

  // Big PNL box.
  const boxY = 216;
  const boxH = 108;
  const boxW = 460;
  roundRect(ctx, pad, boxY, boxW, boxH, 16);
  ctx.fillStyle = accent;
  ctx.fill();
  ctx.fillStyle = accentDark;
  ctx.font = "800 56px Arial, sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(`${positive ? "+" : "-"}${formatUsd(Math.abs(data.pnlUsd))}`, pad + 28, boxY + boxH / 2 + 2);

  // X multiple pill first, then the % pill right after it.
  const pillY = boxY + boxH / 2;
  let x = pad + boxW + 24;
  x += drawPill(ctx, x, pillY, `${data.multipleX.toFixed(2)}x`, "#e5e5e5", "rgba(255,255,255,0.10)") + 14;
  drawPill(
    ctx,
    x,
    pillY,
    `${positive ? "+" : ""}${data.pnlPercent.toFixed(1)}%`,
    accent,
    "rgba(255,255,255,0.10)"
  );

  drawStatRow(ctx, pad, W - pad, 384, "Invested", formatUsd(Math.abs(data.investedUsd)));
  drawStatRow(ctx, pad, W - pad, 444, "Position", formatUsd(Math.abs(data.positionUsd)));

  // Footer: wallet address, left; site link, right.
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#a3a3a3";
  ctx.font = "500 24px 'Courier New', monospace";
  ctx.fillText(shortenAddress(data.walletAddress, 5), pad, H - 56);

  ctx.textAlign = "right";
  ctx.fillStyle = "#a3a3a3";
  ctx.font = "500 24px Arial, sans-serif";
  ctx.fillText(data.siteHost, W - pad, H - 56);
}
