/**
 * Keep the in-memory object for every record whose durable content did not change.
 *
 * Why this is needed at all: a write transaction re-reads the file and decodes it, which produces a
 * brand-new object graph. Two things that used to survive a write therefore stop surviving it —
 * object identity (`store.get(id)` used to be the same object before and after a save) and the
 * *key set* of a record (an optional field explicitly set to `undefined` is not representable in
 * JSON, so it disappears after a round-trip). Both are observable to callers and to tests that
 * compare records, even though the persisted bytes are the same.
 *
 * The rule is deliberately conservative: content that is byte-identical after serialization keeps the
 * previous object; anything else is replaced by the freshly decoded one. Preserving an object never
 * hides a change, because a changed record cannot serialize identically.
 */
export function preserveUnchangedRecords<T extends { id: string }>(previous: readonly T[], next: readonly T[]): T[] {
	if (previous.length === 0) return [...next];
	const byId = new Map(previous.map((record) => [record.id, record]));
	return next.map((record) => {
		const prior = byId.get(record.id);
		if (!prior) return record;
		return sameRecordContent(prior, record) ? prior : record;
	});
}

function sameRecordContent(a: unknown, b: unknown): boolean {
	const left = JSON.stringify(a);
	const right = JSON.stringify(b);
	return left !== undefined && left === right;
}
