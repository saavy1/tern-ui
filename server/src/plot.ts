/**
 * `plot` blocks drawn as SVG: real axes, gridlines, negative values, several
 * series and a legend, which Tern's built-in sparkline cannot do. Colors are
 * mid-tones that read on both dark and light themes, since an image cannot
 * see the pane's CSS.
 */

export interface PlotSeries {
   label?: string;
   y: number[];
   x?: number[];
}

export interface Plot {
   kind?: 'line' | 'area' | 'scatter' | 'step' | 'bar';
   series: PlotSeries[];
   xLabel?: string;
   yLabel?: string;
   xTicks?: string[];
   height?: number;
}

const COLORS = ['#8b7cf6', '#f0a03c', '#3cbfd0', '#ef6b7b', '#5fbf6f', '#d38af0'];
const INK = '#8e939c';
const GRID = 'rgba(142,147,156,0.22)';

/** About `n` round tick values covering [lo, hi]. */
function ticks(lo: number, hi: number, n = 5): number[] {
   if (lo === hi) return [lo];
   const raw = (hi - lo) / n;
   const mag = 10 ** Math.floor(Math.log10(raw));
   const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw) ?? raw;
   const out: number[] = [];
   for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Number(v.toFixed(10)));
   return out;
}

const fmt = (v: number): string => {
   const a = Math.abs(v);
   if (a !== 0 && (a >= 1e5 || a < 1e-3)) return v.toExponential(1);
   return String(Number(v.toPrecision(4)));
};

const esc = (s: string): string => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** The plot as an SVG document. */
export function plotSvg(p: Plot, W = 720): string {
   const kind = p.kind ?? 'line';
   const H = Math.max(140, Math.min(p.height ?? 260, 600));
   const series = p.series.filter(s => s.y.length > 0);
   const legend = series.length > 1 || (series.length === 1 && series[0]!.label);
   const m = { l: 52 + (p.yLabel ? 16 : 0), r: 16, t: legend ? 30 : 14, b: 30 + (p.xLabel ? 18 : 0) };
   const iw = W - m.l - m.r;
   const ih = H - m.t - m.b;

   const xs = series.flatMap(s => s.x ?? s.y.map((_, i) => i));
   const ys = series.flatMap(s => s.y).filter(Number.isFinite);
   let [y0, y1] = [Math.min(...ys, kind === 'bar' || kind === 'area' ? 0 : Infinity), Math.max(...ys)];
   if (y0 === y1) [y0, y1] = [y0 - 1, y1 + 1];
   const yt = ticks(y0, y1);
   y0 = Math.min(y0, yt[0]!);
   y1 = Math.max(y1, yt.at(-1)!);
   const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
   const sx = (x: number): number => m.l + (x1 === x0 ? iw / 2 : ((x - x0) / (x1 - x0)) * iw);
   const sy = (y: number): number => m.t + ih - ((y - y0) / (y1 - y0)) * ih;

   const out: string[] = [];
   out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="-apple-system, Inter, sans-serif" font-size="11">`);
   // Grid and y ticks.
   for (const t of yt) {
      out.push(`<line x1="${m.l}" x2="${W - m.r}" y1="${sy(t)}" y2="${sy(t)}" stroke="${t === 0 ? INK : GRID}" stroke-width="${t === 0 ? 0.8 : 1}"/>`);
      out.push(`<text x="${m.l - 8}" y="${sy(t) + 4}" text-anchor="end" fill="${INK}">${fmt(t)}</text>`);
   }
   // X ticks: labels when given, else round values.
   if (p.xTicks?.length) {
      const n = Math.max(...series.map(s => s.y.length));
      p.xTicks.forEach((label, i) => {
         const x = kind === 'bar' ? m.l + ((i + 0.5) / n) * iw : sx(series[0]?.x?.[i] ?? i);
         out.push(`<text x="${x}" y="${H - m.b + 16}" text-anchor="middle" fill="${INK}">${esc(label)}</text>`);
      });
   } else if (kind !== 'bar') {
      for (const t of ticks(x0, x1, 6)) out.push(`<text x="${sx(t)}" y="${H - m.b + 16}" text-anchor="middle" fill="${INK}">${fmt(t)}</text>`);
   }
   // Series.
   series.forEach((s, k) => {
      const c = COLORS[k % COLORS.length]!;
      const pts = s.y.map((y, i) => [s.x?.[i] ?? i, y] as const).filter(([, y]) => Number.isFinite(y));
      if (kind === 'bar') {
         const n = Math.max(...series.map(t => t.y.length));
         const slot = iw / n;
         const bw = (slot * 0.7) / series.length;
         s.y.forEach((y, i) => {
            const x = m.l + i * slot + slot * 0.15 + k * bw;
            const top = sy(Math.max(y, 0));
            out.push(`<rect x="${x}" y="${top}" width="${bw}" height="${Math.abs(sy(y) - sy(0))}" rx="2" fill="${c}"/>`);
         });
         return;
      }
      if (kind === 'scatter') {
         for (const [x, y] of pts) out.push(`<circle cx="${sx(x)}" cy="${sy(y)}" r="3" fill="${c}"/>`);
         return;
      }
      const path = pts
         .map(([x, y], i) => {
            if (i === 0 || kind !== 'step') return `${i ? 'L' : 'M'}${sx(x).toFixed(1)},${sy(y).toFixed(1)}`;
            return `H${sx(x).toFixed(1)}V${sy(y).toFixed(1)}`;
         })
         .join('');
      if (kind === 'area' && pts.length > 1)
         out.push(`<path d="${path}L${sx(pts.at(-1)![0])},${sy(Math.max(y0, 0))}L${sx(pts[0]![0])},${sy(Math.max(y0, 0))}Z" fill="${c}" fill-opacity="0.18"/>`);
      out.push(`<path d="${path}" fill="none" stroke="${c}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`);
   });
   // Legend.
   if (legend) {
      let x = m.l;
      series.forEach((s, k) => {
         const label = s.label ?? `series ${k + 1}`;
         out.push(`<rect x="${x}" y="10" width="10" height="10" rx="2" fill="${COLORS[k % COLORS.length]}"/>`);
         out.push(`<text x="${x + 15}" y="19" fill="${INK}">${esc(label)}</text>`);
         x += 28 + label.length * 6.5;
      });
   }
   if (p.xLabel) out.push(`<text x="${m.l + iw / 2}" y="${H - 6}" text-anchor="middle" fill="${INK}">${esc(p.xLabel)}</text>`);
   if (p.yLabel)
      out.push(`<text transform="translate(12 ${m.t + ih / 2}) rotate(-90)" text-anchor="middle" fill="${INK}">${esc(p.yLabel)}</text>`);
   out.push('</svg>');
   return out.join('');
}
