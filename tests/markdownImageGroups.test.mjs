import assert from "node:assert/strict";
import test from "node:test";
import { toHast } from "mdast-util-to-hast";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { remarkMarkMultiImageParagraphs } from "../src/renderer/src/utils/markdownPlugins.ts";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { imageGroupCountOf } = loadTsCommonJs("src/renderer/src/components/session/markdownImageGroup.ts");

/**
 * 同段多图的布局标注契约（布置照 dsh：单图按内容尺寸、同段多图缩成 64px 瓷砖）。
 *
 * 图片是逐节点渲染的，组件看不到兄弟节点 —— 所以「这一张是不是多图里的一员」
 * 必须在 mdast 层标到节点上，并经 `mdast-util-to-hast` 的 `data.hProperties`
 * 透传到 hast。这里两头都测：插件写标注、标注真能到 hast、读取口能识别。
 */

function parse(markdown) {
	const processor = unified().use(remarkParse).use(remarkGfm, { singleTilde: false }).use(remarkMarkMultiImageParagraphs);
	return processor.runSync(processor.parse(markdown), markdown);
}

function marksOf(tree) {
	const found = [];
	const visit = (node) => {
		if (!node || typeof node !== "object") return;
		if (node.type === "image") found.push(node.data?.hProperties?.["data-md-image-count"]);
		if (Array.isArray(node.children)) for (const child of node.children) visit(child);
	};
	visit(tree);
	return found;
}

test("同段两张图：两张都标成 2", () => {
	assert.deepEqual(marksOf(parse("![a](/tmp/a.png) ![b](/tmp/b.png)")), ["2", "2"]);
});

test("同段三张图：标成 3", () => {
	assert.deepEqual(marksOf(parse("![a](a.png) ![b](b.png) ![c](c.png)")), ["3", "3", "3"]);
});

test("单张图不标注（保持单图大图规则）", () => {
	assert.deepEqual(marksOf(parse("![a](/tmp/a.png)")), [undefined]);
});

test("分段的图各算各的（不同段落不互相影响）", () => {
	assert.deepEqual(marksOf(parse("![a](/tmp/a.png)\n\n![b](/tmp/b.png)")), [undefined, undefined]);
});

test("图与文字同段：仍按同段多图处理", () => {
	assert.deepEqual(marksOf(parse("说明：![a](a.png) ![b](b.png) 完")), ["2", "2"]);
});

test("标注经 mdast-util-to-hast 透传到 hast 属性（组件就是从这里读的）", () => {
	const hast = toHast(parse("![a](a.png) ![b](b.png)"));
	const images = (hast.children ?? []).flatMap((block) => (block.children ?? []).filter((child) => child.tagName === "img"));
	assert.equal(images.length, 2);
	for (const image of images) assert.equal(image.properties?.["data-md-image-count"], "2");
});

test("imageGroupCountOf：缺失/非法值一律回落 1", () => {
	assert.equal(imageGroupCountOf(undefined), 1);
	assert.equal(imageGroupCountOf(null), 1);
	assert.equal(imageGroupCountOf({}), 1);
	assert.equal(imageGroupCountOf({ properties: {} }), 1);
	assert.equal(imageGroupCountOf({ properties: { "data-md-image-count": "1" } }), 1);
	assert.equal(imageGroupCountOf({ properties: { "data-md-image-count": "abc" } }), 1);
	assert.equal(imageGroupCountOf({ properties: { "data-md-image-count": "2" } }), 2);
	assert.equal(imageGroupCountOf({ properties: { "data-md-image-count": 3 } }), 3);
});
