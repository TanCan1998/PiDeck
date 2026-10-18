import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { resolveHeaderHidden } = loadTsCommonJs("src/renderer/src/web/headerAutoHide.ts");
const { WEB_MOBILE_MAX_WIDTH, isMobileViewport, readViewportWidth } = loadTsCommonJs("src/renderer/src/web/webViewport.ts");

const mobile = { scrollTop: 400, delta: 0, viewportWidth: 375, forceVisible: false };

test("桌面宽度恒展开，忽略滚动位移", () => {
	assert.equal(resolveHeaderHidden(true, { ...mobile, viewportWidth: WEB_MOBILE_MAX_WIDTH + 1, delta: 500 }), false);
	assert.equal(resolveHeaderHidden(false, { ...mobile, viewportWidth: 1440, delta: 500 }), false);
});

test("forceVisible 压过收起判定", () => {
	assert.equal(resolveHeaderHidden(true, { ...mobile, delta: 500, forceVisible: true }), false);
	assert.equal(resolveHeaderHidden(true, { ...mobile, scrollTop: 0, forceVisible: true }), false);
});

test("回顶必然露出顶栏", () => {
	assert.equal(resolveHeaderHidden(true, { ...mobile, scrollTop: 0, delta: 500 }), false);
});

test("向上滚 8px 以上立即展开，8px 以内保持原状", () => {
	assert.equal(resolveHeaderHidden(true, { ...mobile, delta: -9 }), false);
	assert.equal(resolveHeaderHidden(true, { ...mobile, delta: -8 }), true);
	assert.equal(resolveHeaderHidden(true, { ...mobile, delta: -7 }), true);
});

test("向下滚 24px 以上收起，24px 以内保持原状", () => {
	assert.equal(resolveHeaderHidden(false, { ...mobile, delta: 25 }), true);
	assert.equal(resolveHeaderHidden(false, { ...mobile, delta: 24 }), false);
	assert.equal(resolveHeaderHidden(true, { ...mobile, delta: 24 }), true);
});

test("无位移时保持上一次状态", () => {
	assert.equal(resolveHeaderHidden(true, { ...mobile, delta: 0 }), true);
	assert.equal(resolveHeaderHidden(false, { ...mobile, delta: 0 }), false);
});

test("断点边界：760 算移动，761 算桌面", () => {
	assert.equal(isMobileViewport(WEB_MOBILE_MAX_WIDTH), true);
	assert.equal(isMobileViewport(WEB_MOBILE_MAX_WIDTH + 1), false);
	assert.equal(resolveHeaderHidden(true, { ...mobile, viewportWidth: WEB_MOBILE_MAX_WIDTH, delta: 500 }), true);
});

test("非浏览器环境按桌面处理", () => {
	assert.equal(readViewportWidth(), Number.POSITIVE_INFINITY);
});

test("CSS 断点与 JS 常量同源", () => {
	const css = readFileSync("src/renderer/src/web/web.css", "utf8");
	assert.match(css, new RegExp(`@media\\s*\\(max-width:\\s*${WEB_MOBILE_MAX_WIDTH}px\\)`), "web.css 的移动断点必须等于 WEB_MOBILE_MAX_WIDTH，否则 JS 判定与 CSS 布局会漂移");
	const source = readFileSync("src/renderer/src/web/webViewport.ts", "utf8");
	assert.doesNotMatch(source, /from\s+"react"/, "webViewport 是纯模块：引入 React 会让断点判定无法脱离浏览器单测");
});

test("接线契约：收起靠 grid-rows + inert，滚动回调来自时间线", () => {
	const header = readFileSync("src/renderer/src/web/WebHeader.tsx", "utf8");
	assert.match(header, /grid-rows-\[0fr\]/, "收起必须用 grid-rows 过渡，不能用拍脑袋的 max-height");
	assert.match(header, /inert=\{Boolean\(props\.headerHidden\)\}/, "收起态必须 inert：overflow-hidden 只裁剪，看不见的按钮仍可被 Tab 命中");
	assert.match(header, /aria-hidden=\{props\.headerHidden \|\| undefined\}/);

	const app = readFileSync("src/renderer/src/web/WebChatApp.tsx", "utf8");
	assert.match(app, /onScrollTopChange=\{handleTimelineScroll\}/);
	assert.match(app, /data-header-hidden=\{headerHidden \? "on" : undefined\}/);

	const timeline = readFileSync("src/renderer/src/web/WebTimeline.tsx", "utf8");
	assert.match(timeline, /props\.onScrollTopChange\?\.\(\s*el\.scrollTop\s*,\s*delta\s*\)/, "滚动回调必须在既有 onScroll 里上报，不新增监听器");
	assert.match(timeline, /!programmatic\s*&&\s*previousScrollTop\s*!==\s*null\s*&&\s*Math\.abs\(\s*delta\s*\)\s*<=\s*el\.clientHeight/, "程序化滚动与超一屏的跳转都不得触发收起");

	const css = readFileSync("src/renderer/src/web/web.css", "utf8");
	assert.match(css, /\.web-app\[data-header-hidden="on"\]\s+\.message-list\s*>\s*\.scroll-mt-24\s*\{[\s\S]*?scroll-margin-top:\s*0;/, "顶栏收起后消息跳转不再为头部留白");
});

test("接线契约：自动贴底与回到底部算程序化滚动，不参与顶栏收起判定", () => {
	const timeline = readFileSync("src/renderer/src/web/WebTimeline.tsx", "utf8");
	assert.match(timeline, /programmaticScrollRef\.current\s*=\s*true[\s\S]{0,120}el\.scrollTo\(\{\s*top:\s*el\.scrollHeight\s*\}\)/, "流式自动贴底必须先标记程序化，再 scrollTo");
	assert.match(timeline, /suppressUntilNearBottomRef\.current\s*=\s*true/, "回到底部的平滑滚动要持续抑制到贴底为止");
	assert.match(timeline, /const\s+programmatic\s*=\s*programmaticScrollRef\.current\s*\|\|\s*suppressUntilNearBottomRef\.current/, "上报前必须同时看两个抑制标记");
	assert.match(timeline, /if\s*\(!programmatic\s*&&\s*previousScrollTop\s*!==\s*null/, "程序化滚动不得上报位移");
});
