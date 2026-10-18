import { desktopCapturer, nativeImage, type NativeImage } from "electron";

/**
 * Frame pipeline for CUA.
 *
 * Design choices validated by probe2/probe5:
 * - Use desktopCapturer with types:['screen'] (full screen), not ['window'].
 * - Use nativeImage.resize + toJPEG instead of sharp to avoid an extra dependency.
 * - Default maxLongEdge=1280 and quality=75 keeps base64 under ~190KB budget.
 */

export type CaptureOptions = {
	/** If omitted, captures the primary display. */
	displayId?: string;
	/** Resize so the longer edge is at most this many pixels. */
	maxLongEdge?: number;
	/** JPEG quality 1-100. */
	quality?: number;
};

export type Frame = {
	/** JPEG bytes. */
	data: Buffer;
	/** Base64-encoded JPEG. */
	base64: string;
	/** MIME type (image/jpeg). */
	mimeType: string;
	width: number;
	height: number;
	displayId: string;
	timestampMs: number;
	durationMs: number;
};

export const DEFAULT_MAX_LONG_EDGE = 1280;
export const DEFAULT_QUALITY = 75;

/**
 * Requested thumbnail ceiling. `DesktopCapturerSource.thumbnail` IS the capture:
 * Electron scales it down to the requested `thumbnailSize` (aspect preserved),
 * it is never a full-resolution image regardless of what older comments claimed.
 * Requesting 1x1 therefore returns a 1x1 JPEG — observed live on the 0.7.8
 * packaged build where `cua_capture` always answered `width:1, height:1`.
 * Request a ceiling above any real monitor resolution so the source comes back
 * at native size; the resize step below enforces the actual output budget.
 */
export const THUMBNAIL_REQUEST_SIZE = 8192;

/**
 * Capture the full screen and produce a JPEG frame.
 */
export async function captureScreen(options: CaptureOptions = {}): Promise<Frame> {
	const start = Date.now();
	const maxLongEdge = options.maxLongEdge ?? DEFAULT_MAX_LONG_EDGE;
	const quality = options.quality ?? DEFAULT_QUALITY;

	const sources = await desktopCapturer.getSources({
		types: ["screen"],
		thumbnailSize: { width: THUMBNAIL_REQUEST_SIZE, height: THUMBNAIL_REQUEST_SIZE },
	});

	const source = options.displayId ? sources.find((s) => String(s.id) === String(options.displayId)) : sources[0];

	if (!source) {
		throw new Error(`Screen source not found: ${options.displayId ?? "primary"}`);
	}

	let image: NativeImage = source.thumbnail;
	const originalSize = image.getSize();

	const longEdge = Math.max(originalSize.width, originalSize.height);
	if (longEdge > maxLongEdge) {
		const scale = maxLongEdge / longEdge;
		const newWidth = Math.round(originalSize.width * scale);
		const newHeight = Math.round(originalSize.height * scale);
		image = image.resize({ width: newWidth, height: newHeight, quality: "good" });
	}

	const size = image.getSize();
	const data = image.toJPEG(quality);
	const base64 = data.toString("base64");

	return {
		data,
		base64,
		mimeType: "image/jpeg",
		width: size.width,
		height: size.height,
		displayId: source.id,
		timestampMs: Date.now(),
		durationMs: Date.now() - start,
	};
}

/**
 * Build a data URL from a captured frame.
 */
export function frameToDataUrl(frame: Frame): string {
	return `data:${frame.mimeType};base64,${frame.base64}`;
}

/**
 * Estimate base64 byte count for a frame.
 */
export function frameBase64Length(frame: Frame): number {
	return frame.base64.length;
}
