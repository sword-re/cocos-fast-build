/**
 * MaxRects bin-packing(Best-Area-Fit 启发式,支持可选 90° 旋转)。
 *
 * 参考 Jukka Jylänki《A Thousand Ways to Pack the Bin》的 MaxRects 算法。
 * 我们同时生成大图与 SpriteFrame rect,故排版只需自洽,不必复刻编辑器布局。
 *
 * 输入矩形已"膨胀"过(含 bleed/padding),packer 只管放置膨胀后的盒子;
 * 调用方再把内容定位到盒子内部 (x+bleed, y+bleed)。
 */

export interface RectIn {
    id: number; // 原始 item 索引
    w: number; // 膨胀后宽
    h: number; // 膨胀后高
}

export interface RectOut {
    id: number;
    x: number;
    y: number;
    w: number;
    h: number;
    rotated: boolean; // 是否旋转 90°(w/h 互换后放置)
}

interface Free {
    x: number;
    y: number;
    w: number;
    h: number;
}

class MaxRects {
    private free: Free[];
    placed: RectOut[] = [];
    constructor(public binW: number, public binH: number, private allowRotation: boolean) {
        this.free = [{ x: 0, y: 0, w: binW, h: binH }];
    }

    /** 尝试放入一个矩形;放不下返回 false */
    insert(id: number, w: number, h: number): boolean {
        const spot = this.findBestArea(w, h);
        if (!spot) return false;
        this.placed.push({ id, x: spot.x, y: spot.y, w: spot.w, h: spot.h, rotated: spot.rotated });
        this.splitFree(spot);
        this.pruneFree();
        return true;
    }

    private findBestArea(w: number, h: number): RectOut | null {
        let best: RectOut | null = null;
        let bestArea = Infinity;
        let bestShort = Infinity;
        const consider = (rw: number, rh: number, rotated: boolean) => {
            for (const f of this.free) {
                if (f.w < rw || f.h < rh) continue;
                const area = f.w * f.h - rw * rh; // 剩余面积(越小越好)
                const leftover = Math.min(f.w - rw, f.h - rh); // 短边剩余(打平局)
                if (area < bestArea || (area === bestArea && leftover < bestShort)) {
                    bestArea = area;
                    bestShort = leftover;
                    best = { id: -1, x: f.x, y: f.y, w: rw, h: rh, rotated };
                }
            }
        };
        consider(w, h, false);
        if (this.allowRotation && w !== h) consider(h, w, true);
        return best;
    }

    private splitFree(used: RectOut): void {
        const next: Free[] = [];
        for (const f of this.free) {
            // 不相交则保留
            if (used.x >= f.x + f.w || used.x + used.w <= f.x || used.y >= f.y + f.h || used.y + used.h <= f.y) {
                next.push(f);
                continue;
            }
            // 相交:切出上下左右四块剩余
            if (used.x > f.x) next.push({ x: f.x, y: f.y, w: used.x - f.x, h: f.h });
            if (used.x + used.w < f.x + f.w) next.push({ x: used.x + used.w, y: f.y, w: f.x + f.w - (used.x + used.w), h: f.h });
            if (used.y > f.y) next.push({ x: f.x, y: f.y, w: f.w, h: used.y - f.y });
            if (used.y + used.h < f.y + f.h) next.push({ x: f.x, y: used.y + used.h, w: f.w, h: f.y + f.h - (used.y + used.h) });
        }
        this.free = next;
    }

    /** 删除被其它空闲矩形完全包含的冗余项 */
    private pruneFree(): void {
        const f = this.free;
        for (let i = 0; i < f.length; i++) {
            for (let j = i + 1; j < f.length; j++) {
                if (contains(f[j], f[i])) {
                    f.splice(i, 1);
                    i--;
                    break;
                }
                if (contains(f[i], f[j])) {
                    f.splice(j, 1);
                    j--;
                }
            }
        }
    }
}

function contains(a: Free, b: Free): boolean {
    return a.x <= b.x && a.y <= b.y && a.x + a.w >= b.x + b.w && a.y + a.h >= b.y + b.h;
}

export interface PackPageResult {
    width: number;
    height: number;
    rects: RectOut[];
}

/**
 * 把一组膨胀矩形装入若干页(每页 ≤ maxW×maxH)。
 * 贪心:按 max(边长) 降序逐个放;放不下则开新页。每页最后收缩到实际占用边界。
 */
export function packPages(
    rects: RectIn[],
    maxW: number,
    maxH: number,
    opts: { allowRotation: boolean; powerOfTwo: boolean; forceSquared: boolean }
): PackPageResult[] {
    const sorted = [...rects].sort((a, b) => Math.max(b.w, b.h) - Math.max(a.w, a.h) || b.w * b.h - a.w * a.h);
    const pages: PackPageResult[] = [];
    let remaining = sorted;
    while (remaining.length) {
        const bin = new MaxRects(maxW, maxH, opts.allowRotation);
        const leftover: RectIn[] = [];
        for (const r of remaining) {
            if (!bin.insert(r.id, r.w, r.h)) leftover.push(r);
        }
        if (!bin.placed.length) {
            // 单个矩形都放不下(超过 maxW×maxH)——异常,跳过以免死循环
            throw new Error(`图集存在超过单页上限(${maxW}x${maxH})的帧,无法打包: ${JSON.stringify(leftover[0])}`);
        }
        // 收缩到实际占用边界
        let usedW = 0;
        let usedH = 0;
        for (const p of bin.placed) {
            usedW = Math.max(usedW, p.x + p.w);
            usedH = Math.max(usedH, p.y + p.h);
        }
        let pw = usedW;
        let ph = usedH;
        if (opts.powerOfTwo) {
            pw = nextPow2(pw);
            ph = nextPow2(ph);
        }
        if (opts.forceSquared) {
            pw = ph = Math.max(pw, ph);
        }
        pages.push({ width: pw, height: ph, rects: bin.placed });
        remaining = leftover;
    }
    return pages;
}

function nextPow2(n: number): number {
    let p = 1;
    while (p < n) p <<= 1;
    return p;
}
