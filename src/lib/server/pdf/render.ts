/**
 * Quote PDF rendering via pdf-lib. Single entrypoint that branches on
 * `data.quoteType` to either the residential or civil template.
 *
 * Pure data → Uint8Array. No file I/O, no network. The caller (the API
 * endpoint) is responsible for delivering the bytes with the right
 * Content-Type and Content-Disposition headers.
 */

import {
	PDFDocument,
	StandardFonts,
	rgb,
	type PDFFont,
	type PDFImage,
	type PDFPage
} from 'pdf-lib';
import type { Allowance, QuoteData } from '$lib/schemas/quote';
import { multiPolylineLengthMeters, pathToSegments } from '$lib/wall-math';

// A4 in pt (1 inch = 72 pt)
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN_X = 50;
const MARGIN_TOP = 50;
const MARGIN_BOTTOM = 60;
const CONTENT_W = PAGE_W - MARGIN_X * 2;

// Brand colours (kept aligned with the app theme)
const ELITE_ORANGE = rgb(1.0, 0.541, 0.11); // #ff8a1c
const ACCENT_FG = rgb(0.102, 0.059, 0.0); // #1a0f00
const TEXT = rgb(0.067, 0.067, 0.075); // very dark grey
const MUTED = rgb(0.42, 0.44, 0.48); // mid grey
const BORDER = rgb(0.85, 0.85, 0.87); // light grey
const SOFT_BG = rgb(0.97, 0.97, 0.98); // very light grey
const DANGER = rgb(0.86, 0.21, 0.27);
const SUCCESS = rgb(0.18, 0.6, 0.32);

export type PdfTemplate = 'client' | 'installer';

export type PdfPhoto = {
	id: string;
	contentType: string;
	bytes: Uint8Array;
};

export type PdfOptions = {
	quoteNumber: number;
	orgName: string;
	template: PdfTemplate;
	/** Pre-fetched photo bytes from R2. Embedded into the cover block. */
	photos?: PdfPhoto[];
};

export async function renderQuotePdf(
	data: QuoteData,
	opts: PdfOptions
): Promise<Uint8Array> {
	const doc = await PDFDocument.create();
	doc.setTitle(`Quote EW-${opts.quoteNumber} — ${data.client.name || 'Untitled'}`);
	doc.setAuthor(opts.orgName);
	doc.setProducer('Elite Walls Quoting');
	doc.setCreator('Elite Walls Quoting');
	doc.setCreationDate(new Date());

	const reg = await doc.embedFont(StandardFonts.Helvetica);
	const bold = await doc.embedFont(StandardFonts.HelveticaBold);
	const oblique = await doc.embedFont(StandardFonts.HelveticaOblique);

	// Pre-embed photo bytes into the PDF (cap at 4 on the cover block).
	// pdf-lib supports JPEG and PNG natively; anything else is skipped
	// silently — iPad camera output is JPEG so this covers the field case.
	const embeddedPhotos: PDFImage[] = [];
	for (const p of (opts.photos ?? []).slice(0, 4)) {
		try {
			const lower = p.contentType.toLowerCase();
			if (lower.includes('png')) {
				embeddedPhotos.push(await doc.embedPng(p.bytes));
			} else if (lower.includes('jpeg') || lower.includes('jpg')) {
				embeddedPhotos.push(await doc.embedJpg(p.bytes));
			}
			// WebP / HEIC fall through silently — they show in the app but
			// can't be embedded by pdf-lib. iOS-default JPEG is the common path.
		} catch {
			/* unsupported image bytes; skip */
		}
	}

	const ctx: Ctx = {
		doc,
		page: doc.addPage([PAGE_W, PAGE_H]),
		fonts: { reg, bold, oblique },
		opts,
		images: embeddedPhotos,
		y: PAGE_H - MARGIN_TOP,
		pageNum: 1,
		totalPages: 0 // filled at end
	};

	drawHeader(ctx, data);

	if (data.quoteType === 'civil') {
		renderCivil(ctx, data);
	} else {
		renderResi(ctx, data);
	}

	// Number the pages
	const pages = doc.getPages();
	ctx.totalPages = pages.length;
	for (let i = 0; i < pages.length; i++) {
		drawFooter({ ...ctx, page: pages[i], pageNum: i + 1 });
	}

	return doc.save();
}

// ─────────────────────────────────────────────────────────────────────────
//  Layout context + primitives
// ─────────────────────────────────────────────────────────────────────────

type Ctx = {
	doc: PDFDocument;
	page: PDFPage;
	fonts: { reg: PDFFont; bold: PDFFont; oblique: PDFFont };
	opts: PdfOptions;
	images: PDFImage[];
	y: number;
	pageNum: number;
	totalPages: number;
};

function ensureSpace(ctx: Ctx, needed: number) {
	if (ctx.y - needed < MARGIN_BOTTOM) {
		ctx.page = ctx.doc.addPage([PAGE_W, PAGE_H]);
		ctx.y = PAGE_H - MARGIN_TOP;
		ctx.pageNum += 1;
	}
}

function drawText(
	ctx: Ctx,
	text: string,
	opts: {
		font?: PDFFont;
		size?: number;
		color?: ReturnType<typeof rgb>;
		x?: number;
		y?: number;
	} = {}
) {
	const font = opts.font ?? ctx.fonts.reg;
	const size = opts.size ?? 10;
	const color = opts.color ?? TEXT;
	const x = opts.x ?? MARGIN_X;
	const y = opts.y ?? ctx.y;
	ctx.page.drawText(text, { font, size, color, x, y });
}

/** Wrap a string of plain text into lines that fit `maxWidth`. */
function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
	const paragraphs = text.replace(/\r\n/g, '\n').split('\n');
	const out: string[] = [];
	for (const para of paragraphs) {
		if (!para) {
			out.push('');
			continue;
		}
		const words = para.split(/\s+/);
		let line = '';
		for (const w of words) {
			const candidate = line ? line + ' ' + w : w;
			const width = font.widthOfTextAtSize(candidate, size);
			if (width <= maxWidth) {
				line = candidate;
			} else {
				if (line) out.push(line);
				line = w;
			}
		}
		if (line) out.push(line);
	}
	return out;
}

function drawWrappedText(
	ctx: Ctx,
	text: string,
	opts: {
		font?: PDFFont;
		size?: number;
		color?: ReturnType<typeof rgb>;
		x?: number;
		maxWidth?: number;
		lineHeight?: number;
	} = {}
) {
	const font = opts.font ?? ctx.fonts.reg;
	const size = opts.size ?? 10;
	const color = opts.color ?? TEXT;
	const x = opts.x ?? MARGIN_X;
	const maxWidth = opts.maxWidth ?? CONTENT_W;
	const lineHeight = opts.lineHeight ?? size * 1.35;
	const lines = wrap(text, font, size, maxWidth);
	for (const line of lines) {
		ensureSpace(ctx, lineHeight);
		ctx.y -= lineHeight;
		if (line) ctx.page.drawText(line, { font, size, color, x, y: ctx.y });
	}
}

function gap(ctx: Ctx, h: number) {
	ctx.y -= h;
}

function hr(ctx: Ctx, opts: { color?: ReturnType<typeof rgb>; thickness?: number } = {}) {
	ensureSpace(ctx, 6);
	ctx.y -= 4;
	ctx.page.drawLine({
		start: { x: MARGIN_X, y: ctx.y },
		end: { x: MARGIN_X + CONTENT_W, y: ctx.y },
		thickness: opts.thickness ?? 0.5,
		color: opts.color ?? BORDER
	});
	ctx.y -= 4;
}

function drawHeader(ctx: Ctx, data: QuoteData) {
	// Orange brand band across the top.
	ctx.page.drawRectangle({
		x: 0,
		y: PAGE_H - 70,
		width: PAGE_W,
		height: 70,
		color: ELITE_ORANGE
	});

	// "ELITE WALLS" wordmark
	ctx.page.drawText('ELITE WALLS', {
		font: ctx.fonts.bold,
		size: 22,
		color: ACCENT_FG,
		x: MARGIN_X,
		y: PAGE_H - 42
	});
	ctx.page.drawText('Retaining-wall quoting', {
		font: ctx.fonts.reg,
		size: 9,
		color: ACCENT_FG,
		x: MARGIN_X,
		y: PAGE_H - 56
	});

	// Quote meta on the right
	const tmpl = ctx.opts.template === 'client' ? 'CLIENT QUOTE' : 'INSTALLER TAKE-OFF';
	ctx.page.drawText(tmpl, {
		font: ctx.fonts.bold,
		size: 9,
		color: ACCENT_FG,
		x: PAGE_W - MARGIN_X - ctx.fonts.bold.widthOfTextAtSize(tmpl, 9),
		y: PAGE_H - 30
	});
	const qNum = `EW-${ctx.opts.quoteNumber}`;
	ctx.page.drawText(qNum, {
		font: ctx.fonts.bold,
		size: 18,
		color: ACCENT_FG,
		x: PAGE_W - MARGIN_X - ctx.fonts.bold.widthOfTextAtSize(qNum, 18),
		y: PAGE_H - 50
	});
	const dateStr = formatDate(new Date());
	ctx.page.drawText(dateStr, {
		font: ctx.fonts.reg,
		size: 9,
		color: ACCENT_FG,
		x: PAGE_W - MARGIN_X - ctx.fonts.reg.widthOfTextAtSize(dateStr, 9),
		y: PAGE_H - 62
	});

	ctx.y = PAGE_H - 70 - 18;
}

function drawFooter(ctx: Ctx) {
	const txt = `Page ${ctx.pageNum} of ${ctx.totalPages}  ·  ${ctx.opts.orgName}  ·  Quote EW-${ctx.opts.quoteNumber}  ·  Valid 30 days from date of issue`;
	const w = ctx.fonts.reg.widthOfTextAtSize(txt, 8);
	ctx.page.drawText(txt, {
		font: ctx.fonts.reg,
		size: 8,
		color: MUTED,
		x: (PAGE_W - w) / 2,
		y: 28
	});
}

function drawSectionTitle(ctx: Ctx, label: string) {
	ensureSpace(ctx, 26);
	gap(ctx, 18);
	const txt = label.toUpperCase();
	ctx.page.drawText(txt, {
		font: ctx.fonts.bold,
		size: 10,
		color: ELITE_ORANGE,
		x: MARGIN_X,
		y: ctx.y - 10
	});
	ctx.y -= 12;
	// underline
	ctx.page.drawLine({
		start: { x: MARGIN_X, y: ctx.y - 2 },
		end: { x: MARGIN_X + CONTENT_W, y: ctx.y - 2 },
		thickness: 0.5,
		color: BORDER
	});
	ctx.y -= 10;
}

function formatDate(d: Date): string {
	return d.toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' });
}

function fmtMoney(cents: number): string {
	return (cents / 100).toLocaleString('en-AU', {
		style: 'currency',
		currency: 'AUD',
		minimumFractionDigits: 2,
		maximumFractionDigits: 2
	});
}

// ─────────────────────────────────────────────────────────────────────────
//  Reusable sections
// ─────────────────────────────────────────────────────────────────────────

function renderClientSiteBlock(ctx: Ctx, data: QuoteData) {
	drawSectionTitle(ctx, 'Quote for');
	const lines: Array<[string, string]> = [
		['Client', data.client.name || '—'],
		['Phone', data.client.phone || '—'],
		['Email', data.client.email || '—'],
		['Site', data.site.address || '—']
	];
	const colW = CONTENT_W / 2 - 8;
	let leftY = ctx.y;
	let rightY = ctx.y;
	for (let i = 0; i < lines.length; i++) {
		const [k, v] = lines[i];
		const useLeft = i % 2 === 0;
		const x = useLeft ? MARGIN_X : MARGIN_X + CONTENT_W / 2 + 8;
		const startY = useLeft ? leftY : rightY;
		ctx.page.drawText(k.toUpperCase(), {
			font: ctx.fonts.bold,
			size: 7,
			color: MUTED,
			x,
			y: startY - 9
		});
		const valueLines = wrap(v, ctx.fonts.reg, 10, colW);
		let yy = startY - 22;
		for (const line of valueLines) {
			ctx.page.drawText(line, { font: ctx.fonts.reg, size: 10, color: TEXT, x, y: yy });
			yy -= 13;
		}
		const used = 9 + 13 + (valueLines.length - 1) * 13 + 12;
		if (useLeft) leftY = startY - used;
		else rightY = startY - used;
	}
	ctx.y = Math.min(leftY, rightY) - 4;
}

function renderScopeBlock(ctx: Ctx, data: QuoteData) {
	if (!data.scope?.trim()) return;
	drawSectionTitle(ctx, 'Scope of works');
	drawWrappedText(ctx, data.scope.trim(), { size: 10, lineHeight: 14 });
}

function renderQuickHeightsBlock(ctx: Ctx, data: QuoteData) {
	if (data.quoteType !== 'residential') return;
	drawSectionTitle(ctx, 'Wall summary');
	const rows: Array<[string, string]> = [
		['Wall type', data.resiQuick.wallType || '—'],
		['Max retained height', data.resiQuick.maxRetainedMm ? `${data.resiQuick.maxRetainedMm} mm` : '—'],
		[
			'Topper',
			data.resiQuick.topperHeightMm
				? `${data.resiQuick.topperHeightMm} mm ${data.resiQuick.topperType || ''}`.trim()
				: '—'
		],
		[
			'Total wall length',
			`${data.walls
				.reduce(
					(s, w) => s + multiPolylineLengthMeters(pathToSegments(w.pathGeoJson ?? null)),
					0
				)
				.toFixed(2)} m`
		],
		[
			'Engineer cert',
			data.meta.flags.engineerCertRequired ? 'Required (over threshold)' : 'Not required'
		]
	];
	for (const [k, v] of rows) {
		ensureSpace(ctx, 16);
		ctx.page.drawText(k, {
			font: ctx.fonts.reg,
			size: 9,
			color: MUTED,
			x: MARGIN_X,
			y: ctx.y - 10
		});
		ctx.page.drawText(v, {
			font: ctx.fonts.reg,
			size: 10,
			color: TEXT,
			x: MARGIN_X + 160,
			y: ctx.y - 10
		});
		ctx.y -= 16;
	}
}

function renderAllowancesTable(ctx: Ctx, data: QuoteData) {
	if (data.allowances.length === 0) return;
	drawSectionTitle(ctx, 'Allowances');

	const cols = [
		{ x: MARGIN_X + 0, w: 220, label: 'Item' },
		{ x: MARGIN_X + 230, w: 70, label: 'Quantity' },
		{ x: MARGIN_X + 305, w: 50, label: 'Unit' },
		{ x: MARGIN_X + 360, w: CONTENT_W - 360, label: 'Notes' }
	];

	ensureSpace(ctx, 18);
	// Header row
	ctx.page.drawRectangle({
		x: MARGIN_X,
		y: ctx.y - 16,
		width: CONTENT_W,
		height: 16,
		color: SOFT_BG
	});
	for (const c of cols) {
		ctx.page.drawText(c.label.toUpperCase(), {
			font: ctx.fonts.bold,
			size: 7,
			color: MUTED,
			x: c.x + 6,
			y: ctx.y - 11
		});
	}
	ctx.y -= 16;

	// Body
	for (const row of data.allowances) {
		const labelLines = wrap(row.label || '—', ctx.fonts.reg, 9.5, cols[0].w - 6);
		const noteLines = wrap(row.notes || '', ctx.fonts.reg, 9, cols[3].w - 6);
		const rowH = Math.max(16, 4 + Math.max(labelLines.length, noteLines.length || 1) * 12);
		ensureSpace(ctx, rowH);
		const baseY = ctx.y - 12;
		const drawCellText = (
			lines: string[],
			x: number,
			font: PDFFont,
			size: number,
			color: ReturnType<typeof rgb>
		) => {
			let yy = baseY;
			for (const ln of lines) {
				ctx.page.drawText(ln, { font, size, color, x: x + 6, y: yy });
				yy -= 12;
			}
		};
		drawCellText(labelLines, cols[0].x, ctx.fonts.reg, 9.5, TEXT);
		ctx.page.drawText(row.quantity || '—', {
			font: ctx.fonts.reg,
			size: 9.5,
			color: TEXT,
			x: cols[1].x + 6,
			y: baseY
		});
		ctx.page.drawText(row.unit || '—', {
			font: ctx.fonts.reg,
			size: 9.5,
			color: TEXT,
			x: cols[2].x + 6,
			y: baseY
		});
		drawCellText(noteLines.length ? noteLines : [''], cols[3].x, ctx.fonts.reg, 9, MUTED);
		ctx.y -= rowH;
		ctx.page.drawLine({
			start: { x: MARGIN_X, y: ctx.y },
			end: { x: MARGIN_X + CONTENT_W, y: ctx.y },
			thickness: 0.3,
			color: BORDER
		});
	}
}

function renderPricingBlock(ctx: Ctx, data: QuoteData) {
	if (ctx.opts.template === 'installer') return; // installer copy hides pricing
	drawSectionTitle(ctx, 'Pricing');

	const cents = data.pricing;

	if (data.pricing.mode === 'tiered' && data.pricing.tiers.length > 0) {
		// Tier table
		const cols = [
			{ x: MARGIN_X + 0, w: 240, label: 'Description' },
			{ x: MARGIN_X + 240, w: 60, label: 'Qty' },
			{ x: MARGIN_X + 305, w: 50, label: 'Unit' },
			{ x: MARGIN_X + 360, w: 75, label: 'Rate (ex)' },
			{ x: MARGIN_X + 435, w: CONTENT_W - 435, label: 'Total (ex)' }
		];
		ensureSpace(ctx, 18);
		ctx.page.drawRectangle({
			x: MARGIN_X,
			y: ctx.y - 16,
			width: CONTENT_W,
			height: 16,
			color: SOFT_BG
		});
		for (const c of cols) {
			ctx.page.drawText(c.label.toUpperCase(), {
				font: ctx.fonts.bold,
				size: 7,
				color: MUTED,
				x: c.x + 6,
				y: ctx.y - 11
			});
		}
		ctx.y -= 16;
		for (const t of data.pricing.tiers) {
			ensureSpace(ctx, 18);
			const yy = ctx.y - 12;
			const total = Math.round(t.quantity * t.rateCents);
			ctx.page.drawText(t.label || '—', {
				font: ctx.fonts.reg,
				size: 9.5,
				color: TEXT,
				x: cols[0].x + 6,
				y: yy
			});
			ctx.page.drawText(String(t.quantity), {
				font: ctx.fonts.reg,
				size: 9.5,
				color: TEXT,
				x: cols[1].x + 6,
				y: yy
			});
			ctx.page.drawText(t.unit, {
				font: ctx.fonts.reg,
				size: 9.5,
				color: TEXT,
				x: cols[2].x + 6,
				y: yy
			});
			ctx.page.drawText(fmtMoney(t.rateCents), {
				font: ctx.fonts.reg,
				size: 9.5,
				color: TEXT,
				x: cols[3].x + 6,
				y: yy
			});
			ctx.page.drawText(fmtMoney(total), {
				font: ctx.fonts.reg,
				size: 9.5,
				color: TEXT,
				x: cols[4].x + 6,
				y: yy
			});
			ctx.y -= 18;
		}
	} else {
		drawText(ctx, `Lump sum (ex GST): ${fmtMoney(cents.lumpSumCents)}`, {
			y: ctx.y - 12,
			size: 10
		});
		ctx.y -= 18;
	}

	// Totals stack
	const marginAmt = Math.round(cents.subtotalCents * (cents.marginPct / 100));
	const gstAmt = Math.round((cents.subtotalCents + marginAmt) * (cents.gstPct / 100));
	const totalsRows: Array<[string, string, boolean]> = [
		['Subtotal', fmtMoney(cents.subtotalCents), false],
		[`Margin (${cents.marginPct}%)`, fmtMoney(marginAmt), false],
		[`GST (${cents.gstPct}%)`, fmtMoney(gstAmt), false],
		['Total inc GST', fmtMoney(cents.totalCents), true]
	];
	gap(ctx, 6);
	for (const [label, value, emph] of totalsRows) {
		ensureSpace(ctx, 16);
		const font = emph ? ctx.fonts.bold : ctx.fonts.reg;
		const size = emph ? 11 : 9.5;
		const labelW = ctx.fonts.reg.widthOfTextAtSize(label, size);
		const valueW = font.widthOfTextAtSize(value, size);
		const labelX = MARGIN_X + CONTENT_W - 220;
		const valueX = MARGIN_X + CONTENT_W - valueW;
		ctx.page.drawText(label, { font, size, color: emph ? TEXT : MUTED, x: labelX, y: ctx.y - 12 });
		ctx.page.drawText(value, { font, size, color: TEXT, x: valueX, y: ctx.y - 12 });
		void labelW;
		ctx.y -= 16;
		if (emph) {
			ctx.page.drawLine({
				start: { x: labelX, y: ctx.y + 4 },
				end: { x: MARGIN_X + CONTENT_W, y: ctx.y + 4 },
				thickness: 1,
				color: ELITE_ORANGE
			});
		}
	}
}

function renderBullets(ctx: Ctx, title: string, items: string[]) {
	if (items.length === 0) return;
	drawSectionTitle(ctx, title);
	for (const item of items) {
		const lines = wrap(item, ctx.fonts.reg, 9.5, CONTENT_W - 14);
		ensureSpace(ctx, lines.length * 13 + 4);
		// bullet glyph
		ctx.page.drawText('•', {
			font: ctx.fonts.bold,
			size: 11,
			color: ELITE_ORANGE,
			x: MARGIN_X,
			y: ctx.y - 11
		});
		let yy = ctx.y - 11;
		for (const ln of lines) {
			ctx.page.drawText(ln, {
				font: ctx.fonts.reg,
				size: 9.5,
				color: TEXT,
				x: MARGIN_X + 14,
				y: yy
			});
			yy -= 13;
		}
		ctx.y = yy - 2;
	}
}

// ─────────────────────────────────────────────────────────────────────────
//  Templates
// ─────────────────────────────────────────────────────────────────────────

const RESI_INCLUSIONS = [
	'Supply and installation of retaining wall as described in the scope above.',
	'Galvanised steel posts set in concrete piers; sleepers supplied as specified.',
	'Drainage: 20 mm crushed-concrete gravel and 100 mm slotted Class 400 PVC ag pipe behind the wall, with geotextile membrane against the sleepers.',
	'Backfill behind the wall using on-site material.',
	'All works to AS 4678-2002 retaining-walls standard. Engineer certification (Form 15) supplied where required by retained height or surcharge load.'
];

const RESI_EXCLUSIONS = [
	'Geotechnical / soil and global stability reports — by others.',
	'Council DA, BA and inspections — by others.',
	'Site access, cut to height, survey pegs and removal of existing fences/gates unless quoted as an allowance above.',
	'Variations to scope or design caused by latent site conditions (rock, services, contaminated soil) — quoted separately on discovery.',
	'Validity: prices above are valid 30 days from the date of this quote.'
];

const CIVIL_INCLUSIONS = [
	'Post holes bored using a maximum 8-tonne excavator with 400-450 mm auger; piers installed in minimum N25 concrete (N32 where specified).',
	'Sleepers as specified: concrete (200 × 75 mm, plain grey) or composite (200 × 65 mm, Woodlands grey).',
	'Drainage: 20 mm / 40 mm crushed-concrete gravel behind the wall to ~75% of wall height, with geotextile membrane and 100 mm slotted Class 400 PVC ag pipe.',
	'Backfill with on-site subgrade materials, positioned relative to the area to be filled.',
	'Engineer certification (Form 15) and per-lot Form 12 where included in the allowances above.',
	'All works to AS 4678-2002, AS/NZS 1170.0, AS 3600-2009, AS 1726-1993 and AS/NZS 2312-2002.'
];

const CIVIL_EXCLUSIONS = [
	'Geotechnical and global-stability reports — by client / principal contractor.',
	'DA / BA and council inspections — by principal contractor unless agreed in writing.',
	'Walls quoted to 5 kPa loading, 150 kPa min bearing, 19 kN/m³ soil density, 30° friction, 1.0 kPa drained cohesion unless noted above.',
	'Walls based on "stiff clay" (100 kPa) subgrade. Prices may change after soil test or site inspection.',
	'No allowance for latent conditions, contaminated soil, EWP, fall protection or concrete pump — client informed prior if encountered.',
	'Site prepared prior to attendance: access, egress, cut to height, correct RL, survey pegs in place.',
	'Validity: prices above are valid 30 days from the date of this quote.'
];

function renderResi(ctx: Ctx, data: QuoteData) {
	renderClientSiteBlock(ctx, data);
	renderPhotosBlock(ctx);
	renderScopeBlock(ctx, data);
	renderQuickHeightsBlock(ctx, data);
	renderAllowancesTable(ctx, data);
	renderPricingBlock(ctx, data);
	renderBullets(ctx, 'Inclusions', RESI_INCLUSIONS);
	renderBullets(ctx, 'Exclusions', RESI_EXCLUSIONS);
	drawTrailingNote(ctx);
}

function renderCivil(ctx: Ctx, data: QuoteData) {
	renderClientSiteBlock(ctx, data);
	renderPhotosBlock(ctx);
	renderScopeBlock(ctx, data);
	renderWallSchedule(ctx, data);
	renderAllowancesTable(ctx, data);
	renderPricingBlock(ctx, data);
	renderBullets(ctx, 'Inclusions', CIVIL_INCLUSIONS);
	renderBullets(ctx, 'Exclusions', CIVIL_EXCLUSIONS);
	drawTrailingNote(ctx);
}

function renderPhotosBlock(ctx: Ctx) {
	if (ctx.images.length === 0) return;
	drawSectionTitle(ctx, 'Site photos');

	const cellGap = 8;
	const cols = ctx.images.length === 1 ? 1 : 2;
	const cellW = (CONTENT_W - cellGap * (cols - 1)) / cols;
	const cellH = cellW * 0.7; // 10:7 — gives a nice landscape crop
	const rows = Math.ceil(ctx.images.length / cols);
	const totalH = rows * cellH + (rows - 1) * cellGap;
	ensureSpace(ctx, totalH + 4);

	for (let i = 0; i < ctx.images.length; i++) {
		const img = ctx.images[i];
		const row = Math.floor(i / cols);
		const col = i % cols;
		const x = MARGIN_X + col * (cellW + cellGap);
		const yTop = ctx.y - row * (cellH + cellGap);
		const yBottom = yTop - cellH;

		// Fit + centre image inside the cell preserving aspect.
		const sx = cellW / img.width;
		const sy = cellH / img.height;
		const scale = Math.min(sx, sy);
		const drawW = img.width * scale;
		const drawH = img.height * scale;

		// Background panel
		ctx.page.drawRectangle({
			x,
			y: yBottom,
			width: cellW,
			height: cellH,
			color: SOFT_BG,
			borderColor: BORDER,
			borderWidth: 0.5
		});

		ctx.page.drawImage(img, {
			x: x + (cellW - drawW) / 2,
			y: yBottom + (cellH - drawH) / 2,
			width: drawW,
			height: drawH
		});
	}

	ctx.y -= totalH;
}

function renderWallSchedule(ctx: Ctx, data: QuoteData) {
	if (data.walls.length === 0) return;
	drawSectionTitle(ctx, 'Wall schedule');
	const cols = [
		{ x: MARGIN_X + 0, w: 100, label: 'Wall' },
		{ x: MARGIN_X + 100, w: 70, label: 'Length' },
		{ x: MARGIN_X + 175, w: 60, label: 'Posts' },
		{ x: MARGIN_X + 240, w: 90, label: 'Max retained' },
		{ x: MARGIN_X + 330, w: CONTENT_W - 330, label: 'Spacing / Offset' }
	];
	ensureSpace(ctx, 18);
	ctx.page.drawRectangle({
		x: MARGIN_X,
		y: ctx.y - 16,
		width: CONTENT_W,
		height: 16,
		color: SOFT_BG
	});
	for (const c of cols) {
		ctx.page.drawText(c.label.toUpperCase(), {
			font: ctx.fonts.bold,
			size: 7,
			color: MUTED,
			x: c.x + 6,
			y: ctx.y - 11
		});
	}
	ctx.y -= 16;
	for (const w of data.walls) {
		const len = multiPolylineLengthMeters(pathToSegments(w.pathGeoJson ?? null));
		const maxRet =
			w.posts.length === 0
				? 0
				: Math.max(0, ...w.posts.map((p) => Math.max(0, p.rglMm - p.nglMm)));
		const yy = ctx.y - 12;
		ensureSpace(ctx, 18);
		ctx.page.drawText(w.name, {
			font: ctx.fonts.reg,
			size: 9.5,
			color: TEXT,
			x: cols[0].x + 6,
			y: yy
		});
		ctx.page.drawText(`${len.toFixed(2)} m`, {
			font: ctx.fonts.reg,
			size: 9.5,
			color: TEXT,
			x: cols[1].x + 6,
			y: yy
		});
		ctx.page.drawText(String(w.posts.length), {
			font: ctx.fonts.reg,
			size: 9.5,
			color: TEXT,
			x: cols[2].x + 6,
			y: yy
		});
		ctx.page.drawText(`${maxRet} mm`, {
			font: ctx.fonts.reg,
			size: 9.5,
			color: TEXT,
			x: cols[3].x + 6,
			y: yy
		});
		ctx.page.drawText(`${w.defaults.postSpacingMm} mm c/c · ${w.defaults.boundaryOffsetMm} mm`, {
			font: ctx.fonts.reg,
			size: 9.5,
			color: TEXT,
			x: cols[4].x + 6,
			y: yy
		});
		ctx.y -= 18;
	}
}

function drawTrailingNote(ctx: Ctx) {
	gap(ctx, 10);
	ensureSpace(ctx, 36);
	const note =
		'Please don’t hesitate to contact us for any further questions. Reply to this email to accept the quote or request changes.';
	drawWrappedText(ctx, note, {
		font: ctx.fonts.oblique,
		size: 9,
		color: MUTED,
		lineHeight: 13
	});
}

// Re-exported for the unit-test smoke check.
export type { Allowance };
