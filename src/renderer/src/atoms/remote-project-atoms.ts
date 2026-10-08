import { atom } from "jotai";

/**
 * 远端项目登记弹框的开关。
 *
 * 侧栏「+」与引导页空态都可能触发登记，而弹框本身必须全应用只挂一处
 * （见 App.tsx 的 RemoteProjectEnrollDialog），所以这里存开关而不是状态：
 * 主机清单、路径输入、确认请求等域状态由 useRemoteProjectEnroll 持有。
 */
export const remoteEnrollDialogOpenAtom = atom(false);
