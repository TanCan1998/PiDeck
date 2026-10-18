import assert from "node:assert/strict";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";
import { quickMessageHookHost } from "./helpers/quickMessageHookHost.mjs";

/** Run the real controller, geometry and rAF animation without Electron or a model request. */
function sendScrollHarness({ height = 2800, viewportHeight = 600, latestTop = height - 140 } = {}) {
	const host = quickMessageHookHost();
	let now = 0;
	let nextFrame = 0;
	let naturalHeight = height;
	let top = Math.max(0, height - viewportHeight);
	let sessionId = "s1";
	let messages = [{ id: "history-user", role: "user", text: "history", timestamp: 1, agentId: "agent" }];
	const rowTops = new Map([["history-user", latestTop]]);
	const frames = new Map();
	const listeners = new Map();
	const observers = new Set();
	const calls = [];
	const spacer = {
		style: { height: "0px" },
		get offsetHeight() {
			return Number.parseFloat(this.style.height) || 0;
		},
	};
	const viewport = {
		clientHeight: viewportHeight,
		get scrollHeight() {
			return Math.max(viewportHeight, naturalHeight + spacer.offsetHeight);
		},
		get scrollTop() {
			return top;
		},
		set scrollTop(value) {
			top = Math.min(this.scrollHeight - viewportHeight, Math.max(0, value));
		},
		getBoundingClientRect: () => ({ top: 0, bottom: viewportHeight }),
		querySelector(selector) {
			if (selector === "[data-send-scroll-spacer]") return spacer;
			if (selector === '[role="log"]') return content;
			const id = selector.match(/data-message-id="([^"]+)"/)?.[1];
			if (!rowTops.has(id)) return null;
			return { getBoundingClientRect: () => ({ top: rowTops.get(id) - top, bottom: rowTops.get(id) - top + 60 }), dataset: { messageId: id } };
		},
		querySelectorAll: () => [],
		addEventListener(name, listener) {
			listeners.set(name, listener);
		},
		removeEventListener(name, listener) {
			if (listeners.get(name) === listener) listeners.delete(name);
		},
		scrollTo({ top: value }) {
			this.scrollTop = value;
		},
	};
	const content = {
		get offsetHeight() {
			return viewport.scrollHeight;
		},
	};
	const api = {
		stopScroll: () => calls.push("stop"),
		restoreAt(value) {
			calls.push("restore");
			viewport.scrollTop = value;
		},
		scrollToBottom() {
			calls.push("bottom");
			viewport.scrollTop = viewport.scrollHeight - viewportHeight;
		},
	};
	const atoms = {
		sessionMessagesCacheAtom: "cache",
		sessionMessageCacheBySessionIdAtomFamily: () => "entry",
		sessionRecordByIdAtomFamily: () => "record",
		sessionMessageLoadStateAtom: "load",
		sessionScrollAnchorByIdAtom: "anchors",
	};
	const store = {
		get(key) {
			if (key === "cache") return { [sessionId]: { messages, source: "runtime" } };
			if (key === "entry") return { messages, source: "runtime" };
			if (key === "load") return { [sessionId]: { status: "ready" } };
			if (key === "record") return { id: sessionId, projectId: "p1", status: "active" };
			return {};
		},
	};
	const requestAnimationFrame = (fn) => {
		frames.set(++nextFrame, fn);
		return nextFrame;
	};
	const cancelAnimationFrame = (id) => frames.delete(id);
	const react = {
		...host.react,
		useLayoutEffect: host.react.useEffect,
		useMemo(factory, deps) {
			const ref = host.react.useRef();
			if (!ref.current || deps.some((value, index) => !Object.is(value, ref.current.deps[index]))) ref.current = { deps, value: factory() };
			return ref.current.value;
		},
	};
	const load = createTsSandbox({
		stubs: {
			react,
			jotai: { atom: (value) => value, useAtomValue: (key) => (typeof key === "function" ? key() : store.get(key)), useStore: () => store, useSetAtom: () => () => {} },
			"jotai/utils": { selectAtom: (key, select) => () => select(store.get(key)) },
			"../atoms": atoms,
			"../desktopApi": {},
			"../i18n": { t: (key) => key },
		},
		globals: {
			performance: { now: () => now },
			CSS: { escape: (id) => id },
			requestAnimationFrame,
			cancelAnimationFrame,
			ResizeObserver: class {
				constructor(fn) {
					this.fn = fn;
				}
				observe() {
					observers.add(this);
				}
				disconnect() {
					observers.delete(this);
				}
			},
			window: { requestAnimationFrame, cancelAnimationFrame, matchMedia: () => ({ matches: false }), setTimeout: () => 1, clearTimeout: () => {} },
		},
	});
	const { useSessionTimelineController } = load("src/renderer/src/hooks/useSessionTimelineController.ts");
	let controller;
	const render = () =>
		host.render(() => {
			controller = useSessionTimelineController({ sessionId });
			controller.timelineRef.current = viewport;
			controller.scrollerScrollApiRef.current = api;
			return controller;
		});
	const advance = (ms = 16) => {
		now += ms;
		const pending = [...frames.values()];
		frames.clear();
		for (const fn of pending) fn(now);
		render();
	};
	render();
	advance();
	calls.length = 0;
	return {
		viewport,
		spacer,
		calls,
		render,
		advance,
		get controller() {
			return controller;
		},
		browse(value = 160) {
			controller.setAutoScrollFromScroller(false);
			viewport.scrollTop = value;
			render();
		},
		send(id = "d04a3300-3147-42fb-b8bc-9f0a587ece3b", { reply = false } = {}) {
			rowTops.set(id, naturalHeight - 20);
			naturalHeight += 100;
			messages = [...messages, { id, role: "user", text: "new question", timestamp: now, agentId: "agent" }];
			if (reply) messages.push({ id: "assistant-new", role: "assistant", text: "reply", timestamp: now, agentId: "agent" });
			render();
			return id;
		},
		stream() {
			naturalHeight += 20;
			messages = [...messages];
			render();
			for (const observer of observers) observer.fn();
		},
		resizeAbove(delta) {
			naturalHeight += delta;
			for (const [id, value] of rowTops) rowTops.set(id, value + delta);
			for (const observer of observers) observer.fn();
		},
		rowGap(id) {
			return rowTops.get(id) - viewport.scrollTop;
		},
		input(name = "wheel") {
			listeners.get(name)?.({ type: name });
		},
		switchSession() {
			sessionId = "s2";
			messages = [{ id: "other-user", role: "user", text: "other", timestamp: 2, agentId: "other" }];
			rowTops.set("other-user", 200);
			naturalHeight = 400;
			render();
		},
		finish() {
			for (let i = 0; i < 55; i++) advance();
		},
		unmount: host.unmount,
	};
}

test("sending a UUID user message from scrolled history smoothly brings it to the top", () => {
	const h = sendScrollHarness();
	try {
		h.browse();
		const start = h.viewport.scrollTop;
		const id = h.send();
		h.advance();
		assert.ok(Math.abs(h.viewport.scrollTop - start) < 1, "sending must not snap before the animation");
		h.advance();
		assert.ok(h.viewport.scrollTop - start < 20, "animation must ease into a long journey");
		h.finish();
		assert.ok(Math.abs(h.rowGap(id) - 24) <= 1, `new question is at ${h.rowGap(id)}px, not the viewport top`);
	} finally {
		h.unmount();
	}
});

test("short conversations do not acquire artificial scroll space or lose follow mode", () => {
	const h = sendScrollHarness({ height: 160 });
	try {
		h.send();
		h.advance();
		h.finish();
		assert.equal(h.viewport.scrollTop, 0);
		assert.equal(h.spacer.offsetHeight, 0);
		assert.equal(h.controller.autoScroll, true);
	} finally {
		h.unmount();
	}
});

test("a fast assistant append does not hide the new user message from send positioning", () => {
	const h = sendScrollHarness();
	try {
		const id = h.send(undefined, { reply: true });
		h.advance();
		h.finish();
		assert.ok(Math.abs(h.rowGap(id) - 24) <= 1);
	} finally {
		h.unmount();
	}
});

test("stream rerenders do not cancel the send animation and consumed space shrinks without a jump", () => {
	const h = sendScrollHarness();
	try {
		h.browse();
		const id = h.send();
		h.advance();
		for (let i = 0; i < 12; i++) {
			h.advance();
			h.stream();
		}
		h.finish();
		assert.ok(Math.abs(h.rowGap(id) - 24) <= 1);
		const space = h.spacer.offsetHeight;
		const top = h.viewport.scrollTop;
		h.stream();
		assert.equal(h.spacer.offsetHeight, Math.max(0, space - 20));
		assert.equal(h.viewport.scrollTop, top);
		assert.equal(h.controller.autoScroll, true, "normal streaming follow resumes after the one-off positioning");
	} finally {
		h.unmount();
	}
});

test("manual scrolling cancels send positioning immediately without removing space and clamping", () => {
	const h = sendScrollHarness();
	try {
		h.browse();
		h.send();
		for (let i = 0; i < 12; i++) h.advance();
		h.input();
		const stopped = h.viewport.scrollTop;
		h.finish();
		assert.equal(h.viewport.scrollTop, stopped);
		assert.equal(h.controller.autoScroll, false);
	} finally {
		h.unmount();
	}
});

test("session switching disposes send animation and spacer instead of scrolling the new session", () => {
	const h = sendScrollHarness();
	try {
		h.browse();
		h.send();
		h.advance();
		h.switchSession();
		h.finish();
		assert.equal(h.spacer.offsetHeight, 0);
		assert.equal(h.viewport.scrollTop, 0);
	} finally {
		h.unmount();
	}
});

test("history mounting alone never replays a send animation", () => {
	const h = sendScrollHarness();
	try {
		h.finish();
		assert.equal(h.spacer.offsetHeight, 0);
		assert.equal(h.viewport.scrollTop, 2200);
		assert.deepEqual(h.calls, []);
	} finally {
		h.unmount();
	}
});
