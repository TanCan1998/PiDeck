/** 快捷消息 hook 的确定性宿主：模拟 React 槽位、依赖与卸载，不依赖 DOM 或真实计时器。 */
export function quickMessageHookHost() {
	const slots = [];
	let cursor = 0;
	let effects = [];
	const sameDeps = (previous, next) => previous && next && previous.length === next.length && previous.every((value, index) => Object.is(value, next[index]));
	const react = {
		useState(initial) {
			const index = cursor++;
			if (!(index in slots)) slots[index] = { value: typeof initial === "function" ? initial() : initial };
			return [
				slots[index].value,
				(next) => {
					slots[index].value = typeof next === "function" ? next(slots[index].value) : next;
				},
			];
		},
		useRef(value) {
			return (slots[cursor++] ??= { current: value });
		},
		useCallback(callback, deps) {
			const index = cursor++;
			if (!sameDeps(slots[index]?.deps, deps)) slots[index] = { value: callback, deps };
			return slots[index].value;
		},
		useEffect(effect, deps) {
			const index = cursor++;
			if (!sameDeps(slots[index]?.deps, deps))
				effects.push(() => {
					slots[index]?.cleanup?.();
					slots[index] = { cleanup: effect(), deps };
				});
		},
		useMemo(factory, deps) {
			const index = cursor++;
			if (!sameDeps(slots[index]?.deps, deps)) slots[index] = { value: factory(), deps };
			return slots[index].value;
		},
	};
	return {
		react,
		render(callback) {
			cursor = 0;
			const result = callback();
			const pending = effects;
			effects = [];
			for (const effect of pending) effect();
			return result;
		},
		unmount() {
			for (const slot of slots) slot?.cleanup?.();
		},
	};
}
