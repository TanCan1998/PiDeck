package main

// 条目表落盘（Wave 2b）测试：复用、尾部增量、损坏/过期回退、目录上限。
//
// 核心手法：「改写源文件内容但保持 size 与 mtime 完全一致」——如果实现真的走了磁盘
// 条目文件，返回值会保留旧内容；一旦偷偷重扫源文件就会被发现（与 TS 侧
// session-summary-cache 的版本键测试同一招）。

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const persistedFixtureBody = `{"id":"s1","type":"session","timestamp":"2026-02-01T00:00:00.000Z"}` + "\n" +
	`{"id":"a1","parentId":"s1","type":"message","message":{"role":"user","content":[{"type":"text","text":"first"}]}}` + "\n" +
	`{"id":"a2","parentId":"a1","type":"message","message":{"role":"assistant","content":[{"type":"text","text":"second"}]}}` + "\n"

func tableIDs(entryTable table) []string {
	ids := make([]string, 0, len(entryTable.Entries))
	for _, entry := range entryTable.Entries {
		ids = append(ids, entry.ID)
	}
	return ids
}

func assertIDs(t *testing.T, entryTable table, want ...string) {
	t.Helper()
	got := tableIDs(entryTable)
	if len(got) != len(want) {
		t.Fatalf("条目数不符：got %v want %v", got, want)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("条目顺序不符：got %v want %v", got, want)
		}
	}
}

// 落盘后换一个新进程实例（新 tableCache）读取：拿到的必须是磁盘条目，
// 而不是重扫源文件的结果。
func TestPersistedTableReusedAcrossCacheInstances(t *testing.T) {
	fixture := newFixture(t)
	source := fixture.path("sessions/persist.jsonl")
	fixture.write("sessions/persist.jsonl", persistedFixtureBody)
	tablesDir := filepath.Join(fixture.root, "tables")

	first, err := getIndexTable(newTableCache(tablesDir), source)
	if err != nil {
		t.Fatalf("首次 getIndexTable 失败: %v", err)
	}
	assertIDs(t, first, "s1", "a1", "a2")

	info, err := os.Stat(source)
	if err != nil {
		t.Fatalf("stat 失败: %v", err)
	}
	tableFile := tableFilePath(tablesDir, source)
	if _, err := os.Stat(tableFile); err != nil {
		t.Fatalf("条目文件应已落盘: %v", err)
	}

	// 同长度改写（role user → USER）+ 还原 mtime：条目表里有 role 字段，
	// 只有真的复用了磁盘条目才会仍然读到小写 user（重扫会变成 USER）。
	mutated := strings.ReplaceAll(persistedFixtureBody, `"user"`, `"USER"`)
	if len(mutated) != len(persistedFixtureBody) {
		t.Fatalf("测试前提：改写后长度必须一致，%d vs %d", len(mutated), len(persistedFixtureBody))
	}
	if err := os.WriteFile(source, []byte(mutated), 0o644); err != nil {
		t.Fatalf("改写源文件失败: %v", err)
	}
	if err := os.Chtimes(source, info.ModTime(), info.ModTime()); err != nil {
		t.Fatalf("还原 mtime 失败: %v", err)
	}

	second, err := getIndexTable(newTableCache(tablesDir), source)
	if err != nil {
		t.Fatalf("二次 getIndexTable 失败: %v", err)
	}
	assertIDs(t, second, "s1", "a1", "a2")
	if second.MtimeMs != first.MtimeMs || second.Size != first.Size {
		t.Fatalf("版本键应保持一致: %+v vs %+v", second, first)
	}
	// 条目字段来自磁盘条目文件（未被重扫覆盖）。
	if second.Entries[1].Role == nil || *second.Entries[1].Role != "user" {
		t.Fatalf("应复用磁盘条目里的 role=user，实际 %+v（说明偷偷重扫了源文件）", second.Entries[1].Role)
	}
}

// 文件只变长（pi 正常追加）且上次停在换行边界：复用旧条目 + 只解析尾部。
func TestPersistedTableAppendsTailIncrementally(t *testing.T) {
	fixture := newFixture(t)
	source := fixture.path("sessions/append.jsonl")
	fixture.write("sessions/append.jsonl", persistedFixtureBody)
	tablesDir := filepath.Join(fixture.root, "tables")

	if _, err := getIndexTable(newTableCache(tablesDir), source); err != nil {
		t.Fatalf("首次 getIndexTable 失败: %v", err)
	}

	appendLine := `{"id":"a3","parentId":"a2","type":"message","message":{"role":"user","content":[{"type":"text","text":"appended"}]}}` + "\n"
	handle, err := os.OpenFile(source, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatalf("打开源文件失败: %v", err)
	}
	if _, err := handle.WriteString(appendLine); err != nil {
		t.Fatalf("追加失败: %v", err)
	}
	handle.Close()

	grown, err := getIndexTable(newTableCache(tablesDir), source)
	if err != nil {
		t.Fatalf("增量读取失败: %v", err)
	}
	assertIDs(t, grown, "s1", "a1", "a2", "a3")
	if !grown.EndsWithNewline {
		t.Fatal("追加完整行后 endsWithNewline 应为 true")
	}
	// 增量路径必须保留旧条目的 offset（复用而不是重扫）：第三条应从旧文件末尾开始。
	if grown.Entries[3].Offset != int64(len(persistedFixtureBody)) {
		t.Fatalf("新条目 offset 应等于旧文件大小 %d，实际 %d", len(persistedFixtureBody), grown.Entries[3].Offset)
	}

	// 增量结果同样落盘：再换实例读到的应是 4 条。
	reloaded, err := getIndexTable(newTableCache(tablesDir), source)
	if err != nil {
		t.Fatalf("重载失败: %v", err)
	}
	assertIDs(t, reloaded, "s1", "a1", "a2", "a3")
}

// 上次停在残行边界（endsWithNewline=false）时不能做增量：残行会被当成整行固化。
func TestPersistedTableRejectsIncrementalWhenTailWasPartial(t *testing.T) {
	fixture := newFixture(t)
	source := fixture.path("sessions/partial.jsonl")
	fixture.write("sessions/partial.jsonl", `{"id":"s1","type":"session"}`+"\n"+`{"id":"a1","parentId":"s1","type":"message"}`)
	tablesDir := filepath.Join(fixture.root, "tables")

	first, err := getIndexTable(newTableCache(tablesDir), source)
	if err != nil {
		t.Fatalf("首次 getIndexTable 失败: %v", err)
	}
	if first.EndsWithNewline {
		t.Fatal("测试前提：残行结尾应为 false")
	}

	handle, err := os.OpenFile(source, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatalf("打开源文件失败: %v", err)
	}
	if _, err := handle.WriteString("\n" + `{"id":"a2","parentId":"a1","type":"message"}` + "\n"); err != nil {
		t.Fatalf("补全失败: %v", err)
	}
	handle.Close()

	reloaded, err := getIndexTable(newTableCache(tablesDir), source)
	if err != nil {
		t.Fatalf("重扫失败: %v", err)
	}
	// 全量重扫：s1、a1（原残行现在完整了）、a2；不能出现两条 a1。
	assertIDs(t, reloaded, "s1", "a1", "a2")
	if !reloaded.EndsWithNewline {
		t.Fatal("补全换行后 endsWithNewline 应为 true")
	}
}

// 条目文件损坏：丢弃并重扫，绝不把错误抛给宿主（宿主会因此回退 TS，没必要）。
func TestPersistedTableCorruptionFallsBackToScan(t *testing.T) {
	fixture := newFixture(t)
	source := fixture.path("sessions/corrupt.jsonl")
	fixture.write("sessions/corrupt.jsonl", persistedFixtureBody)
	tablesDir := filepath.Join(fixture.root, "tables")

	if _, err := getIndexTable(newTableCache(tablesDir), source); err != nil {
		t.Fatalf("首次 getIndexTable 失败: %v", err)
	}
	tableFile := tableFilePath(tablesDir, source)
	if err := os.WriteFile(tableFile, []byte("not json at all\n"), 0o644); err != nil {
		t.Fatalf("写坏条目文件失败: %v", err)
	}

	recovered, err := getIndexTable(newTableCache(tablesDir), source)
	if err != nil {
		t.Fatalf("损坏后应回退重扫，实际报错: %v", err)
	}
	assertIDs(t, recovered, "s1", "a1", "a2")

	// 重扫结果会覆盖坏文件：下一个实例能正常命中磁盘。
	again, err := getIndexTable(newTableCache(tablesDir), source)
	if err != nil {
		t.Fatalf("恢复后读取失败: %v", err)
	}
	assertIDs(t, again, "s1", "a1", "a2")
}

// 文件被截短（重写/归档）：版本键不匹配且不可增量 → 全量重扫。
func TestPersistedTableRejectsShrunkSource(t *testing.T) {
	fixture := newFixture(t)
	source := fixture.path("sessions/shrink.jsonl")
	fixture.write("sessions/shrink.jsonl", persistedFixtureBody)
	tablesDir := filepath.Join(fixture.root, "tables")

	if _, err := getIndexTable(newTableCache(tablesDir), source); err != nil {
		t.Fatalf("首次 getIndexTable 失败: %v", err)
	}
	fixture.write("sessions/shrink.jsonl", `{"id":"s1","type":"session"}`+"\n")

	rescanned, err := getIndexTable(newTableCache(tablesDir), source)
	if err != nil {
		t.Fatalf("重扫失败: %v", err)
	}
	assertIDs(t, rescanned, "s1")
}

// 没给目录时退化成纯内存缓存，不创建任何文件。
func TestPersistedTableDisabledWithoutDirectory(t *testing.T) {
	fixture := newFixture(t)
	source := fixture.path("sessions/memory-only.jsonl")
	fixture.write("sessions/memory-only.jsonl", persistedFixtureBody)

	cache := newTableCache("")
	if _, err := getIndexTable(cache, source); err != nil {
		t.Fatalf("内存模式失败: %v", err)
	}
	entries, err := os.ReadDir(fixture.root)
	if err != nil {
		t.Fatalf("readdir 失败: %v", err)
	}
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), tableFileSuffix) {
			t.Fatalf("内存模式不应产生条目文件: %s", entry.Name())
		}
	}
}

// 目录上限：超过 maxTableFiles 时按修改时间淘汰最旧的，且永不删刚写的那个。
func TestPrunePersistedTablesKeepsNewestAndCurrent(t *testing.T) {
	dir := t.TempDir()
	base := time.Now().Add(-time.Hour)
	paths := make([]string, 0, maxTableFiles+3)
	for index := 0; index <= maxTableFiles+2; index++ {
		path := filepath.Join(dir, strings.Repeat("x", 3)+string(rune('a'+index%26))+string(rune('a'+index/26))+tableFileSuffix)
		if err := os.WriteFile(path, []byte("{}\n"), 0o644); err != nil {
			t.Fatalf("写文件失败: %v", err)
		}
		stamp := base.Add(time.Duration(index) * time.Second)
		if err := os.Chtimes(path, stamp, stamp); err != nil {
			t.Fatalf("设置 mtime 失败: %v", err)
		}
		paths = append(paths, path)
	}

	// 把最旧的那个当 keepPath：它必须活下来，多删掉一个倒数第二旧的。
	keepPath := paths[0]
	prunePersistedTables(dir, keepPath)

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("readdir 失败: %v", err)
	}
	if len(entries) > maxTableFiles {
		t.Fatalf("淘汰后仍超上限：%d > %d", len(entries), maxTableFiles)
	}
	if _, err := os.Stat(keepPath); err != nil {
		t.Fatalf("keepPath 不应被删除: %v", err)
	}
	if _, err := os.Stat(paths[len(paths)-1]); err != nil {
		t.Fatalf("最新的文件不应被删除: %v", err)
	}
}
