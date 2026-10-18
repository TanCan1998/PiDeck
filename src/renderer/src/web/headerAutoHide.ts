import { isMobileViewport } from "./webViewport";

export type HeaderAutoHideInput = {
	scrollTop: number;
	delta: number;
	viewportWidth: number;
	forceVisible: boolean;
};

const REVEAL_DELTA = -8;
const HIDE_DELTA = 24;

export function resolveHeaderHidden(previous: boolean, input: HeaderAutoHideInput): boolean {
	if (!isMobileViewport(input.viewportWidth)) return false;
	if (input.forceVisible) return false;
	if (input.scrollTop <= 0) return false;
	if (input.delta < REVEAL_DELTA) return false;
	if (input.delta > HIDE_DELTA) return true;
	return previous;
}
