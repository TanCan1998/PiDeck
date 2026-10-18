import assert from "node:assert";
import test from "node:test";
import { loadTsCommonJs } from "../helpers/loadTsCommonJs.mjs";

// 顶层不带 electron stub 也能加载：npm `electron` 包在非 Electron 运行时导出
// 的是二进制路径字符串，destructure 出 undefined，仅 captureScreen 不可用。
const CuaFrame = loadTsCommonJs("src/main/cua/CuaFrame.ts");

function makeElectronStub({ sources, calls }) {
	return {
		desktopCapturer: {
			getSources: async (opts) => {
				calls.push(opts);
				return sources;
			},
		},
		nativeImage: {
			createFromDataURL: () => ({ isEmpty: () => true }),
		},
	};
}

function makeFakeImage({ width, height, resizedTo }) {
	return {
		getSize: () => ({ width, height }),
		resize: (opts) => {
			assert.ok(opts.width > 0 && opts.height > 0, "resize needs positive dims");
			resizedTo.push(opts);
			return {
				getSize: () => ({ width: opts.width, height: opts.height }),
				resize: () => {
					throw new Error("double resize should never happen");
				},
				toJPEG: () => Buffer.from(`jpeg-${opts.width}x${opts.height}`),
			};
		},
		toJPEG: () => Buffer.from(`jpeg-${width}x${height}`),
	};
}

function loadFrameWithSources(sources, calls) {
	return loadTsCommonJs("src/main/cua/CuaFrame.ts", {
		stubs: { electron: makeElectronStub({ sources, calls }) },
	});
}

test("default capture options match probe5 budget", () => {
	// 1280 long edge / quality 75 keeps 2560x1440 frames under ~190KB base64.
	assert.strictEqual(CuaFrame.DEFAULT_MAX_LONG_EDGE, 1280);
	assert.strictEqual(CuaFrame.DEFAULT_QUALITY, 75);
});

test("captureScreen requests a large thumbnail ceiling, never 1x1 (regression)", async () => {
	// 2026-10 实机回归：thumbnailSize {1,1} 让 Electron 把 capture 缩到 1 像素，
	// 打包版 cua_capture 恒返回 width:1,height:1（CUA "看屏幕" 整体失效）。
	const calls = [];
	const resizedTo = [];
	const mod = loadFrameWithSources([{ id: "screen:0:0", thumbnail: makeFakeImage({ width: 2560, height: 1440, resizedTo }) }], calls);

	const frame = await mod.captureScreen();
	assert.strictEqual(calls.length, 1);
	const requested = calls[0].thumbnailSize;
	assert.ok(requested.width >= mod.DEFAULT_MAX_LONG_EDGE, `thumbnailSize must cover the output budget, got ${requested.width}x${requested.height}`);
	assert.ok(requested.height >= mod.DEFAULT_MAX_LONG_EDGE);

	// 1280 long edge: 2560x1440 → 1280x720
	assert.strictEqual(frame.width, 1280);
	assert.strictEqual(frame.height, 720);
	assert.strictEqual(resizedTo.length, 1, "oversized source is resized once");
	assert.strictEqual(frame.mimeType, "image/jpeg");
	assert.strictEqual(frame.displayId, "screen:0:0");
});

test("captureScreen skips resize when the source already fits the budget", async () => {
	const calls = [];
	const resizedTo = [];
	const mod = loadFrameWithSources([{ id: "screen:0:0", thumbnail: makeFakeImage({ width: 800, height: 600, resizedTo }) }], calls);

	const frame = await mod.captureScreen();
	assert.strictEqual(frame.width, 800);
	assert.strictEqual(frame.height, 600);
	assert.strictEqual(resizedTo.length, 0, "no redundant resize within budget");
});

test("captureScreen throws when the requested displayId is not found", async () => {
	const mod = loadFrameWithSources([{ id: "screen:0:0", thumbnail: makeFakeImage({ width: 800, height: 600, resizedTo: [] }) }], []);
	await assert.rejects(() => mod.captureScreen({ displayId: "screen:9:9" }), /Screen source not found/);
});
