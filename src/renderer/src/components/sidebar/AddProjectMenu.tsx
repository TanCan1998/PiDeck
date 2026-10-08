import { FolderPlus, Plus, Server } from "lucide-react";
import { useSetAtom } from "jotai";
import { remoteEnrollDialogOpenAtom } from "../../atoms/remote-project-atoms";
import { t } from "../../i18n";
import { Button } from "../ui-shadcn/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../ui-shadcn/dropdown-menu";

/**
 * 「+ 添加项目」菜单：两个入口都指向**真实且不同**的行为。
 *
 * - 「本地目录…」走现有本地/WSL 目录选择（App 的 projects.add），行为不变；
 * - 「远端（SSH）…」打开远端登记弹框：选已验证主机 → 输入绝对路径 → canonical 确认 → 登记。
 *
 * 刻意不做成两个都指向同一行为的假菜单项，也不在这里放远端主机管理（那是设备设置）。
 */
export function AddProjectMenu(props: { onAddLocal: () => void; labeled?: boolean }) {
	const setRemoteOpen = useSetAtom(remoteEnrollDialogOpenAtom);
	// labeled：空态里的大号主按钮形态；默认是侧栏分组标题栏的图标按钮形态。
	const trigger = props.labeled ? (
		<Button type="button" variant="secondary" size="sm" className="mt-3" title={t("app.addProject")} aria-label={t("app.addProject")}>
			<FolderPlus className="size-3.5" aria-hidden="true" />
			{t("app.addProject")}
		</Button>
	) : (
		<Button type="button" variant="ghost" size="icon-xs" className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={t("app.addProject")} title={t("app.addProject")}>
			<Plus className="size-3.5" aria-hidden="true" />
		</Button>
	);
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
			<DropdownMenuContent align={props.labeled ? "center" : "end"} sideOffset={4} className="min-w-44">
				<DropdownMenuItem onSelect={() => props.onAddLocal()}>
					<FolderPlus className="size-3.5" aria-hidden="true" />
					{t("sidebar.addProjectLocal")}
				</DropdownMenuItem>
				<DropdownMenuItem onSelect={() => setRemoteOpen(true)}>
					<Server className="size-3.5" aria-hidden="true" />
					{t("sidebar.addProjectRemote")}
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
