import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent } from "react";
import { useAtomValue } from "jotai";
import { projectByIdAtomFamily } from "../../atoms/project-atoms";
import { isRemoteProject } from "../../../../shared/projectLocation";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { openInSystemBrowser } from "../../utils/openExternal";
import { remoteTerminalErrorMessage } from "../../utils/remoteTerminalErrors";
import { showNotice } from "../../utils/notice";
import { writeClipboard } from "../../utils/clipboard";
import { ChevronDown, ChevronUp, MoreHorizontal, Plus, X } from "lucide-react";
import { ConfirmDialog } from "../ui-shadcn/ConfirmDialog";
import { Button } from "../ui-shadcn/button";
import { Popover, PopoverContent, PopoverTrigger } from "../ui-shadcn/popover";
import type { PiDesktopApi } from "../../../../preload";
import { terminalOwnerKeyFor } from "../../../../shared/types/terminal";
import type { TerminalShell, TerminalTab, TerminalTarget } from "../../../../shared/types";
import { t } from "../../i18n";

const TERMINAL_THEMES = {
	"pi-soft": {
		label: "Pi Soft",
		xterm: {
			background: "#ffffff",
			foreground: "#243244",
			cursor: "#18181b",
			selectionBackground: "#e4e4e7",
		},
		xtermDark: {
			background: "#09090b",
			foreground: "#e4e4e7",
			cursor: "#fafafa",
			selectionBackground: "#3f3f46",
		},
	},
	"solarized-light": {
		label: "Solarized Light",
		xterm: {
			background: "#fdf6e3",
			foreground: "#657b83",
			cursor: "#268bd2",
			selectionBackground: "#eee8d5",
		},
	},
	"solarized-dark": {
		label: "Solarized Dark",
		xterm: {
			background: "#002b36",
			foreground: "#839496",
			cursor: "#2aa198",
			selectionBackground: "#073642",
		},
	},
	"one-dark": {
		label: "One Dark",
		xterm: {
			background: "#282c34",
			foreground: "#abb2bf",
			cursor: "#98c379",
			selectionBackground: "#3e4451",
		},
	},
	monokai: {
		label: "Monokai",
		xterm: {
			background: "#272822",
			foreground: "#f8f8f2",
			cursor: "#a6e22e",
			selectionBackground: "#49483e",
		},
	},
} as const;

type TerminalThemeId = keyof typeof TERMINAL_THEMES;

const TERMINAL_OPEN_ANIMATION_MS = 300;

function stripReplayBuffer(tab: TerminalTab): TerminalTab {
	const { buffer: _buffer, ...rest } = tab;
	return rest;
}

/** Runtime refresh can remount xterm after the composer/editor already claimed keyboard input. */
function focusWithoutStealingInput(terminal: Terminal, container: HTMLElement | null): void {
	const focused = document.activeElement;
	if (focused?.matches("input, textarea, [contenteditable='true']") && !container?.contains(focused)) return;
	terminal.focus();
}

export function TerminalDock(props: {
	target: TerminalTarget;
	open: boolean;
	closing: boolean;
	collapsed: boolean;
	height: number;
	terminal: PiDesktopApi["terminal"];
	onCollapsedChange: (collapsed: boolean) => void;
	onHeightChange: (height: number) => void;
	onClose: () => void;
	/** 可选：终端归属键（agent:<id> / project:<id>）；缺省时按 target 推导 */
	sessionKey?: string;
}) {
	const containerRef = useRef<HTMLDivElement>(null);
	const xtermRef = useRef<Terminal | null>(null);
	const fitRef = useRef<FitAddon | null>(null);
	const activeTabIdRef = useRef("");
	const buffersRef = useRef<Record<string, string>>({});
	const sequencesRef = useRef<Record<string, number>>({});
	const loadedIdsRef = useRef(new Set<string>());
	// 归属键：决定加载 gate 与 pending 占位判断；project 终端由父级显式传入
	const sessionKey = props.sessionKey ?? terminalOwnerKeyFor(props.target);
	/* copyNotice 已改用 toast (sonner) 实现 */
	const [tabs, setTabs] = useState<TerminalTab[]>([]);
	const [activeTabId, setActiveTabId] = useState("");
	const [themeId, setThemeId] = useState<TerminalThemeId>("pi-soft");
	const [themeMenuOpen, setThemeMenuOpen] = useState(false);
	const [confirmCloseAllOpen, setConfirmCloseAllOpen] = useState(false);
	/* copyNotice 已改用 toast (sonner) 实现 */
	const [loading, setLoading] = useState(false);
	const [contentReady, setContentReady] = useState(false);
	const [motionOpen, setMotionOpen] = useState(false);
	const [appTheme, setAppTheme] = useState(() => document.documentElement.dataset.theme ?? "light");
	/** 壁纸模式：终端背景跟随输出区同档透明度（canvas/DOM 渲染的背景必须走 JS） */
	const [wallpaperMode, setWallpaperMode] = useState(() => document.documentElement.dataset.bgImage === "on");
	/** 可用 shell 列表 */
	const [shells, setShells] = useState<{ shell: string; label: string; available: boolean }[]>([]);
	const [shellMenuOpen, setShellMenuOpen] = useState(false);
	const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];
	const project = useAtomValue(projectByIdAtomFamily(props.target.kind === "project" ? props.target.projectId : ""));
	// Shell appearance must be correct while loading/failed, before any main-signed SSH tab exists.
	// Project metadata is presentation-only; main still resolves and verifies every launch target.
	const remoteTerminal = (project !== undefined && isRemoteProject(project)) || activeTab?.location === "ssh";
	const theme = TERMINAL_THEMES[themeId];
	const xtermTheme = useMemo(() => {
		const base = themeId === "pi-soft" && appTheme === "dark" && "xtermDark" in theme ? theme.xtermDark : theme.xterm;
		if (!wallpaperMode || !base.background.startsWith("#")) return base;
		// 注：xterm 的颜色解析只支持 hex（含 9 位 #RRGGBBAA），
		// "transparent"/rgba() 会解析失败回退黑色——必须输出 hex+alpha。
		if (base.background.length === 7) {
			const hex = base.background.slice(1);
			const r = Number.parseInt(hex.slice(0, 2), 16);
			const g = Number.parseInt(hex.slice(2, 4), 16);
			const b = Number.parseInt(hex.slice(4, 6), 16);
			const isLight = (r + g + b) / 3 > 128;
			if (isLight) {
				// 浅色主题：全透明（#RRGGBB00），透出 chat-pane 单层，与输出区同透明度。
				return { ...base, background: `${base.background}00` };
			}
			// 深色主题：保留主题底色 + 全局面板档 alpha（深底深透，浅字仍可读）。
			const raw = getComputedStyle(document.documentElement).getPropertyValue("--wallpaper-panel-alpha").trim();
			const mix = Number.parseFloat(raw);
			const alpha = Number.isFinite(mix) ? Math.min(1, Math.max(0, mix / 100)) : 0.8;
			const alphaHex = Math.round(alpha * 255)
				.toString(16)
				.padStart(2, "0");
			return { ...base, background: `${base.background}${alphaHex}` };
		}
		return base;
	}, [themeId, appTheme, wallpaperMode]);
	const { open, collapsed } = props;

	useEffect(() => {
		if (props.closing) return;
		const frame = window.requestAnimationFrame(() => setMotionOpen(true));
		return () => window.cancelAnimationFrame(frame);
	}, [props.closing]);

	// Grid 行高每帧变化时，xterm 的首次 fit 和缓冲区回放会抢占主线程。
	// 先完成面板开场动画，再初始化终端，避免入口点击出现掉帧。
	useEffect(() => {
		if (!open) {
			setContentReady(false);
			return;
		}
		const timer = window.setTimeout(() => setContentReady(true), TERMINAL_OPEN_ANIMATION_MS);
		return () => window.clearTimeout(timer);
	}, [open]);

	useEffect(() => {
		const root = document.documentElement;
		const observer = new MutationObserver(() => {
			setAppTheme(root.dataset.theme ?? "light");
			setWallpaperMode(root.dataset.bgImage === "on");
		});
		observer.observe(root, {
			attributes: true,
			attributeFilter: ["data-theme", "data-bg-image"],
		});
		return () => observer.disconnect();
	}, []);

	useEffect(() => {
		activeTabIdRef.current = activeTab?.id ?? "";
	}, [activeTab?.id]);

	useEffect(() => {
		if (!open || !contentReady || !sessionKey) return;
		// pending-* 是渲染层占位，主进程还没有对应 agent runtime
		if (sessionKey.startsWith("pending-")) return;
		let cancelled = false;
		async function loadTabs() {
			setLoading(true);
			try {
				const nextTabs = await props.terminal.ensure(props.target);
				if (cancelled) return;
				buffersRef.current = nextTabs.reduce<Record<string, string>>(
					(current, tab) => ({
						...current,
						[tab.id]: tab.buffer ?? current[tab.id] ?? "",
					}),
					{ ...buffersRef.current },
				);
				loadedIdsRef.current = new Set(nextTabs.map((tab) => tab.id));
				for (const tab of nextTabs)
					if (tab.outputSequence !== undefined) {
						sequencesRef.current[tab.id] = tab.outputSequence;
						void props.terminal.acknowledge(tab.id, tab.outputSequence).catch(() => undefined);
					}
				setTabs(nextTabs.map(stripReplayBuffer));
				setActiveTabId(nextTabs[0]?.id ?? "");
			} catch (error) {
				// ensure 失败不能变成 unhandled rejection：Mac 上会表现为启动 agent 后终端报错/像闪退
				if (!cancelled) {
					setTabs([]);
					setActiveTabId("");
					const message = error instanceof Error ? error.message : String(error);
					// Agent 尚未就绪时的竞态：静默跳过，等真实 agentId 再挂载
					if (!/Agent not found/i.test(message)) {
						showNotice(/REMOTE_|SSH_/.test(message) ? remoteTerminalErrorMessage(error) : message, 4000, "error");
					}
				}
			} finally {
				if (!cancelled) setLoading(false);
			}
		}
		void loadTabs();
		return () => {
			cancelled = true;
		};
	}, [
		// target 序列化键：agent 绑定变更（restart）或项目切换都会重建终端实例
		props.target.kind === "agent" ? `agent:${props.target.agentId}:${props.target.runtimeGeneration}` : `project:${props.target.projectId}`,
		props.terminal,
		open,
		contentReady,
	]);

	// Remote targets never query or display the local shell candidates, including startup failures.
	useEffect(() => {
		if (!open || !contentReady) return;
		if (remoteTerminal) return;
		let cancelled = false;
		void props.terminal
			.shells()
			.then((list) => {
				if (!cancelled) setShells(list);
			})
			.catch(() => {
				// shell 列表失败不阻断终端主体
				if (!cancelled) setShells([]);
			});
		return () => {
			cancelled = true;
		};
	}, [props.terminal, open, contentReady, remoteTerminal]);

	useEffect(() => {
		const offData = props.terminal.onData((payload) => {
			if (!loadedIdsRef.current.has(payload.tabId)) return;
			if (payload.sequence !== undefined && payload.sequence <= (sequencesRef.current[payload.tabId] ?? 0)) return;
			buffersRef.current[payload.tabId] = ((buffersRef.current[payload.tabId] ?? "") + payload.data).slice(-128 * 1024);
			if (payload.sequence !== undefined) sequencesRef.current[payload.tabId] = payload.sequence;
			const acknowledge = () => {
				if (payload.sequence !== undefined) void props.terminal.acknowledge(payload.tabId, payload.sequence).catch(() => undefined);
			};
			if (payload.tabId === activeTabIdRef.current && xtermRef.current) xtermRef.current.write(payload.data, acknowledge);
			else acknowledge();
		});
		const offExit = props.terminal.onExit((payload) => {
			if (!loadedIdsRef.current.has(payload.tabId)) return;
			setTabs((current) => current.map((tab) => (tab.id === payload.tabId ? { ...tab, exited: true, exitCode: payload.exitCode, exitReason: payload.reason } : tab)));
			const exitText = payload.reason ? `\r\n[${remoteTerminalErrorMessage(payload.reason)}]\r\n` : `\r\n[process exited${payload.exitCode != null ? ` with code ${payload.exitCode}` : ""}]\r\n`;
			buffersRef.current[payload.tabId] = ((buffersRef.current[payload.tabId] ?? "") + exitText).slice(-128 * 1024);
			if (payload.tabId === activeTabIdRef.current) xtermRef.current?.write(exitText);
		});
		return () => {
			offData();
			offExit();
		};
	}, [props.terminal]);

	useEffect(() => {
		xtermRef.current = null;
		fitRef.current = null;
		if (collapsed || !contentReady || !activeTab || !containerRef.current) return;

		// 终端字体接入设置 token：字体族跟随 --font-family-mono（设置中「代码字体」），
		// 字号跟随 --font-size-control（UI 字号轨，默认 13px 与历史硬编码一致）。
		// xterm.js 需要具体字体串（canvas 测量用），不能用 var()，故挂载时展开一次；
		// 设置变更后新开的终端生效，已开终端保持本次会话字体（xterm 无热更新入口）。
		const rootStyle = getComputedStyle(document.documentElement);
		const fontFamily = rootStyle.getPropertyValue("--font-family-mono").trim() || '"Cascadia Mono", Consolas, monospace';
		const fontSize = parseFloat(rootStyle.getPropertyValue("--font-size-control")) || 13;

		const terminal = new Terminal({
			cursorBlink: true,
			fontFamily,
			fontSize,
			scrollback: 5000,
			theme: xtermTheme,
		});
		const fit = new FitAddon();
		terminal.loadAddon(fit);
		// 终端内 URL 可点：交给系统浏览器，与消息区链接策略一致（#115 U3）
		terminal.loadAddon(new WebLinksAddon((_event, uri) => openInSystemBrowser(uri)));
		terminal.open(containerRef.current);
		let resizeFrame: number | null = null;
		const dataDisposable = terminal.onData((data) => {
			if (!activeTab.exited) void props.terminal.input(activeTab.id, data).catch((error) => showNotice(remoteTerminalErrorMessage(error), 4000, "error"));
		});
		const resize = () => {
			fit.fit();
			if (!activeTab.exited) {
				void props.terminal.resize(activeTab.id, terminal.cols, terminal.rows).catch(() => undefined);
			}
		};
		const scheduleResize = () => {
			if (resizeFrame != null) window.cancelAnimationFrame(resizeFrame);
			resizeFrame = window.requestAnimationFrame(() => {
				resizeFrame = null;
				resize();
			});
		};
		const observer = new ResizeObserver(scheduleResize);
		observer.observe(containerRef.current);
		resize();
		terminal.write(buffersRef.current[activeTab.id] ?? "", () => {
			terminal.scrollToBottom();
			scheduleResize();
		});

		xtermRef.current = terminal;
		fitRef.current = fit;
		const focusFrame = window.requestAnimationFrame(() => {
			scheduleResize();
			focusWithoutStealingInput(terminal, containerRef.current);
		});
		return () => {
			if (resizeFrame != null) window.cancelAnimationFrame(resizeFrame);
			window.cancelAnimationFrame(focusFrame);
			observer.disconnect();
			dataDisposable.dispose();
			terminal.dispose();
		};
	}, [activeTab, collapsed, contentReady, props.terminal, xtermTheme]);

	useEffect(() => {
		fitRef.current?.fit();
		if (activeTab && xtermRef.current && !activeTab.exited) {
			void props.terminal.resize(activeTab.id, xtermRef.current.cols, xtermRef.current.rows).catch(() => undefined);
		}
	}, [props.height, activeTab, props.terminal]);

	useEffect(() => {
		if (collapsed || !contentReady || !activeTab || activeTab.exited) return;
		const frame = requestAnimationFrame(() => {
			if (xtermRef.current) focusWithoutStealingInput(xtermRef.current, containerRef.current);
		});
		return () => cancelAnimationFrame(frame);
	}, [activeTab?.id, activeTab?.exited, collapsed, contentReady]);

	/* copyNotice cleanup 已禁用（改为 toast sonner） */

	async function addTabWithShell(shell: string) {
		setShellMenuOpen(false);
		await addTab(shell as TerminalShell);
	}

	async function addTab(shell?: TerminalShell) {
		try {
			const next = await props.terminal.create(props.target, shell);
			loadedIdsRef.current.add(next.id);
			buffersRef.current[next.id] = next.buffer ?? "";
			if (next.outputSequence !== undefined) {
				sequencesRef.current[next.id] = next.outputSequence;
				void props.terminal.acknowledge(next.id, next.outputSequence).catch(() => undefined);
			}
			setTabs((current) => [...current, stripReplayBuffer(next)]);
			setActiveTabId(next.id);
			props.onCollapsedChange(false);
		} catch (error) {
			showNotice(remoteTerminalErrorMessage(error), 4000, "error");
		}
	}

	async function closeTab(tab: TerminalTab) {
		try {
			await props.terminal.close(tab.id);
		} catch {
			// tab 可能已退出；继续做本地清理
		}
		delete buffersRef.current[tab.id];
		delete sequencesRef.current[tab.id];
		loadedIdsRef.current.delete(tab.id);
		const nextTabs = tabs.filter((item) => item.id !== tab.id);
		setTabs(nextTabs);
		if (nextTabs.length === 0) {
			props.onClose();
			return;
		}
		if (tab.id === activeTab?.id) {
			setActiveTabId(nextTabs[nextTabs.length - 1].id);
		}
	}

	async function closeAllTabs() {
		if (tabs.length === 0) return;
		await Promise.all(tabs.map((tab) => props.terminal.close(tab.id).catch(() => undefined)));
		buffersRef.current = {};
		sequencesRef.current = {};
		loadedIdsRef.current.clear();
		setTabs([]);
		setConfirmCloseAllOpen(false);
		props.onClose();
	}

	async function copySelectionOnContextMenu(event: ReactMouseEvent<HTMLDivElement>) {
		const selection = xtermRef.current?.getSelection();
		if (!selection) return;

		// xterm 默认右键会落到浏览器菜单；选区存在时直接复制，符合桌面终端的右键复制习惯。
		event.preventDefault();
		event.stopPropagation();
		await writeClipboard(selection);
		showNotice(t("terminal.copied"), 1200);
		xtermRef.current?.focus();
	}

	function focusTerminalSoon() {
		window.requestAnimationFrame(() => xtermRef.current?.focus());
	}

	// #115 U5：dock 高度由外层 react-resizable-panels 面板持有（分隔条拖拽），
	// 手写 pointer 拖拽与 .terminal-resize-handle 已删除；这里充满父面板即可。
	return (
		<section className={`terminal-dock${collapsed ? " collapsed" : ""}`} data-theme={themeId} data-open={open} data-motion-state={props.closing || !motionOpen ? "hidden" : "visible"} style={{ height: "100%" }}>
			<header className="terminal-dock-header flex shrink-0 items-center justify-between gap-2 border-b px-2">
				{/* Shell 下拉菜单 absolute 向上弹出会超出 terminal-tabs（overflow-hidden）而被裁剪，
			    所以左侧整体包一层无 overflow 的容器，选择器独立于 tabs 滚动域之外 */}
				<div className="flex min-w-0 items-center">
					<div className="terminal-tabs flex min-w-0 items-center gap-0.5 overflow-hidden">
						{tabs.map((tab) => (
							<div key={tab.id} className={`terminal-tab inline-flex max-w-[9rem] items-center gap-0.5 rounded-md px-0.5 pl-2${tab.id === activeTab?.id ? " active" : ""}`}>
								<Button
									variant="ghost"
									size="sm"
									className="terminal-tab-label h-auto min-w-0 flex-1 justify-start truncate px-2 py-0.5 max-w-[6.5rem] min-w-0 flex-1 truncate text-left"
									onClick={() => {
										setActiveTabId(tab.id);
										props.onCollapsedChange(false);
										focusTerminalSoon();
									}}
								>
									{tab.title}
									{tab.exited ? ` · ${t("terminal.exited")}` : ""}
								</Button>
								<Button
									type="button"
									variant="ghost"
									size="icon-xs"
									className="terminal-tab-close size-5 grid size-5 shrink-0 place-items-center rounded-sm opacity-60"
									onClick={(event) => {
										event.stopPropagation();
										void closeTab(tab);
									}}
									title={t("terminal.closeCurrent")}
								>
									<X size={12} />
								</Button>
							</div>
						))}
						<Button type="button" variant="ghost" size="icon-xs" className="terminal-icon-btn size-6 inline-grid size-6 shrink-0 place-items-center rounded-md" onClick={() => void addTab()} title={t("terminal.new")} disabled={loading || !contentReady}>
							<Plus size={14} />
						</Button>
					</div>
					{/* Shell 选择器：点击创建指定 shell 的终端。必须用 Portal 化的 Popover——
				    dock 挂在 react-resizable-panels 的 Panel 里，Panel 内层是 overflow:auto
				    容器，菜单向上弹出会被裁剪（表现为「下拉没有值」）；Popover 渲染到 body，
				    不受任何祖先 overflow 影响，且自带碰撞翻转与外部点击关闭。 */}
					{!remoteTerminal && (
						<Popover open={shellMenuOpen} onOpenChange={setShellMenuOpen}>
							<PopoverTrigger asChild>
								<Button type="button" variant="ghost" size="icon-xs" className="terminal-icon-btn size-6 inline-grid size-6 place-items-center rounded-md" title={t("terminal.selectShell")} disabled={loading || !contentReady}>
									<ChevronDown size={12} />
								</Button>
							</PopoverTrigger>
							<PopoverContent side="top" align="start" className="w-44 gap-0.5 p-1.5">
								<strong className="px-1 py-0.5 text-xs">{t("terminal.selectShell")}</strong>
								{shells.length === 0 && <span className="block px-1 py-1 text-[11px] text-muted-foreground">{t("terminal.shellEmpty")}</span>}
								{shells.map((s) => (
									<Button
										key={s.shell}
										type="button"
										variant="ghost"
										size="sm"
										className={`h-auto w-full justify-start rounded-md px-2 py-1 text-left text-xs hover:bg-accent${s.available ? "" : " unavailable opacity-50"}`}
										onClick={() => {
											if (!s.available) return;
											void addTabWithShell(s.shell);
										}}
										title={s.available ? undefined : t("terminal.shellNotAvailable")}
									>
										{s.label}
									</Button>
								))}
							</PopoverContent>
						</Popover>
					)}
					{remoteTerminal && (
						<span className="px-2 text-xs text-muted-foreground" title={t("terminal.remoteShell")}>
							SSH · /bin/sh
						</span>
					)}
				</div>
				<div className="terminal-actions flex shrink-0 items-center gap-0.5">
					<Popover open={themeMenuOpen} onOpenChange={setThemeMenuOpen}>
						<PopoverTrigger asChild>
							<Button type="button" variant="ghost" size="icon-xs" className="terminal-icon-btn size-6 inline-grid size-6 place-items-center rounded-md" title={t("terminal.more")}>
								<MoreHorizontal size={14} />
							</Button>
						</PopoverTrigger>
						<PopoverContent side="top" align="end" className="w-48 gap-1 p-2">
							<strong className="px-1 text-xs">{t("terminal.theme")}</strong>
							<span className="px-1 text-[11px] text-muted-foreground">
								{t("terminal.themeCurrent")}: {theme.label}
							</span>
							{Object.entries(TERMINAL_THEMES).map(([id, item]) => (
								<Button
									key={id}
									type="button"
									variant="ghost"
									size="sm"
									className={`h-auto w-full justify-start rounded-md px-2 py-1 text-left text-xs hover:bg-accent${id === themeId ? " active bg-accent" : ""}`}
									onClick={() => {
										setThemeId(id as TerminalThemeId);
										setThemeMenuOpen(false);
									}}
								>
									{item.label}
								</Button>
							))}
						</PopoverContent>
					</Popover>
					<Button
						type="button"
						variant="ghost"
						size="icon-xs"
						className="terminal-icon-btn size-6 inline-grid size-6 place-items-center rounded-md"
						onClick={() => {
							props.onCollapsedChange(!collapsed);
							focusTerminalSoon();
						}}
						title={collapsed ? t("terminal.expand") : t("terminal.collapse")}
					>
						{collapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
					</Button>
					<Button type="button" variant="ghost" size="icon-xs" className="terminal-icon-btn size-6 inline-grid size-6 place-items-center rounded-md" onClick={() => setConfirmCloseAllOpen(true)} title={t("terminal.closeAll")} disabled={tabs.length === 0}>
						<X size={14} />
					</Button>
				</div>
			</header>
			{!collapsed && (
				<div className="terminal-pane-shell" onPointerDownCapture={focusTerminalSoon} onContextMenu={(event) => void copySelectionOnContextMenu(event)}>
					{(loading || !contentReady) && <div className="terminal-placeholder">{t("terminal.starting")}</div>}
					<div ref={containerRef} className="terminal-xterm" />
					{/* copyNotice 已改用 toast (sonner) 实现 */}
				</div>
			)}
			{confirmCloseAllOpen && <ConfirmDialog title={t("terminal.closeAllConfirm")} message={t("terminal.closeAllDescription")} confirmLabel={t("terminal.closeAll")} danger onConfirm={() => void closeAllTabs()} onCancel={() => setConfirmCloseAllOpen(false)} />}
		</section>
	);
}
