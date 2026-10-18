import { atom } from "jotai";
import { atomFamily } from "jotai/utils";
import type { PiCommand } from "../../../shared/types";

/**
 * 每会话的 runtime 命令表，按 sessionId 隔离。
 *
 * 历史消息里 `/命令` chip 的白名单必须跟随「渲染这条消息的会话」而不是全局聚焦会话，
 * 分屏两栏各自读写自己的键，互不串扰（旧实现是 App 级单份 state，非聚焦栏会拿到
 * 聚焦会话的命令表，导致另一栏的命令 chip 渲染错乱/丢失）。
 */
export const sessionCommandsAtomFamily = atomFamily((sessionId: string) => atom<PiCommand[]>([]));
