/**
 * 每主机 FIFO 操作锁（Phase 3 第一批 A）。
 *
 * 为什么需要它：一台远端主机只服务**一个** helper 会话，而该会话的 `--root` 在生命周期内固定。
 * 因此「为项目 B 建立会话」必然拆掉项目 A 正在读取的那条会话——切根与读取绝不能交错。
 * 上一版只把切根串行化（remoteHostIpc 的 rootSwitchByHost），整次读取落在队列外，
 * 于是 B 的切根可以插进 A 多分块读取的两块之间，把该文件剩下的部分交给 B 的 root 服务。
 *
 * 本模块对调用方承诺的性质（每一条都承重）：
 * - 同 key FIFO：一台主机的操作按到达顺序执行，永不并发。
 * - 失败隔离：任务抛错也会释放 key，下一个等待者照常运行。
 * - 不同 key 互不阻塞：主机之间保持独立。
 * - 无人等待的 key 会被删除，映射不会无界增长。
 *
 * 刻意不提供超时或取消：调用方自己拥有截止时间（传输层有自己的 deadline），
 * 而一个永不结算的任务会一直持有 key——这正是「会话绑定」要暴露出来的事实，而不是在这里悄悄兜住。
 */
export type RemoteHostOperationLock = {
	run<T>(key: string, task: () => Promise<T>): Promise<T>;
	/** 该 key 上是否有操作正在运行或排队（诊断与测试用）。 */
	isBusy(key: string): boolean;
};

export function createRemoteHostOperationLock(): RemoteHostOperationLock {
	const tails = new Map<string, Promise<void>>();

	async function run<T>(key: string, task: () => Promise<T>): Promise<T> {
		const previous = tails.get(key) ?? Promise.resolve();
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		// 存进 map 的 tail 只在本操作结束时兑现，且永不 reject：结果只由调用方自己的 promise 承载。
		const tail = previous.then(() => gate);
		tails.set(key, tail);
		await previous.catch(() => undefined);
		try {
			return await task();
		} finally {
			release();
			// 只有该 key 的最后一个等待者才能移除它；更早的一个会把仍在使用的链条挤掉。
			if (tails.get(key) === tail) tails.delete(key);
		}
	}

	return {
		run,
		isBusy: (key) => tails.has(key),
	};
}
