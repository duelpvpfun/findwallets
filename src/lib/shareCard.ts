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
  ctx.font = "700 38px Arial, sans-serif";
  const paddingX = 26;
  const height = 62;
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
  ctx.font = "600 32px Arial, sans-serif";
  ctx.fillText(label, xLeft, y);
  ctx.textAlign = "right";
  ctx.fillStyle = "#fafafa";
  ctx.font = "700 40px Arial, sans-serif";
  ctx.fillText(value, xRight, y);
  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(xLeft, y + 40);
  ctx.lineTo(xRight, y + 40);
  ctx.stroke();
}

/** Draws the "α" mark used in the site header: a glowing light glyph on a
 * dark rounded badge, sized for the card's top-left corner. */
function drawAlphaLogo(ctx: CanvasRenderingContext2D, x: number, y: number, size: number) {
  roundRect(ctx, x, y, size, size, size * 0.28);
  ctx.fillStyle = "#101014";
  ctx.fill();
  ctx.save();
  ctx.shadowColor = "rgba(147,197,253,0.75)";
  ctx.shadowBlur = size * 0.35;
  ctx.fillStyle = "#f5f5f5";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `700 ${Math.round(size * 0.62)}px Arial, sans-serif`;
  ctx.fillText("α", x + size / 2, y + size / 2 + size * 0.04);
  ctx.restore();
}

export async function drawPnlCard(canvas: HTMLCanvasElement, data: ShareCardData): Promise<void> {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is not supported in this browser.");
  const W = (canvas.width = CARD_WIDTH);
  const H = (canvas.height = CARD_HEIGHT);
  const pad = 64;

  const bg = await loadImage(pickBackground(data.walletAddress));
  ctx.drawImage(bg, 0, 0, W, H);

  // Flat dark overlay so white text stays legible regardless of the
  // underlying background's own contrast.
  ctx.fillStyle = "rgba(0,0,0,0.45)";
  ctx.fillRect(0, 0, W, H);

  const positive = data.pnlUsd >= 0;
  const accent = positive ? "#34d399" : "#fb7185";
  const accentDark = positive ? "#052e1c" : "#450a0a";

  // Logo mark, top-left.
  drawAlphaLogo(ctx, pad, 52, 68);

  // Brand, top-right.
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#fafafa";
  ctx.font = "700 40px Arial, sans-serif";
  ctx.fillText("AlphaWallets", W - pad, 86);

  // Coin tag.
  ctx.textAlign = "left";
  ctx.fillStyle = "#f5f5f5";
  ctx.font = "800 72px Arial, sans-serif";
  ctx.fillText(`$${data.symbol.toUpperCase()}`, pad, 238);

  // Big PNL box.
  const boxY = 276;
  const boxH = 172;
  const boxW = 700;
  roundRect(ctx, pad, boxY, boxW, boxH, 22);
  ctx.fillStyle = accent;
  ctx.fill();
  ctx.fillStyle = accentDark;
  ctx.font = "800 92px Arial, sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(`${positive ? "+" : "-"}${formatUsd(Math.abs(data.pnlUsd))}`, pad + 36, boxY + boxH / 2 + 4);

  // X multiple pill above the % pill, stacked vertically to the right of the
  // box so neither runs off the right edge of the card.
  const pillX = pad + boxW + 28;
  drawPill(ctx, pillX, boxY + boxH / 2 - 38, `${data.multipleX.toFixed(2)}x`, "#e5e5e5", "rgba(255,255,255,0.12)");
  drawPill(
    ctx,
    pillX,
    boxY + boxH / 2 + 38,
    `${positive ? "+" : ""}${data.pnlPercent.toFixed(1)}%`,
    accent,
    "rgba(255,255,255,0.12)"
  );

  drawStatRow(ctx, pad, W - pad, boxY + boxH + 90, "Invested", formatUsd(Math.abs(data.investedUsd)));
  drawStatRow(ctx, pad, W - pad, boxY + boxH + 158, "Position", formatUsd(Math.abs(data.positionUsd)));

  // Footer: wallet address, left; site link, right.
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#d4d4d4";
  ctx.font = "600 30px 'Courier New', monospace";
  ctx.fillText(shortenAddress(data.walletAddress, 4), pad, H - 60);

  ctx.textAlign = "right";
  ctx.fillStyle = "#d4d4d4";
  ctx.font = "700 30px Arial, sans-serif";
  ctx.fillText(data.siteHost, W - pad, H - 60);
}
