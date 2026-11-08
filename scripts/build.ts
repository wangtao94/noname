import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import { buildAssetManifest } from "./build-asset-manifest.ts";
import { precompress } from "./precompress.ts";
const skipAssets = process.env.NONAME_BUILD_SKIP_ASSETS === "1";
const coreBuild = spawnSync("pnpm -F noname... build", {
	shell: true,
	stdio: "inherit",
});

if (coreBuild.status !== 0) process.exit(coreBuild.status ?? 1);
const extensionBuild = spawnSync("pnpm -F ./packages/extension/** build", {
	shell: true,
	stdio: "inherit",
});

if (extensionBuild.status !== 0) process.exit(extensionBuild.status ?? 1);
console.log("合并打包结果");
await fs.rm("dist", { recursive: true, force: true });
await fs.mkdir("dist", { recursive: true });
await Promise.all([
	// Web build and optional large asset copies.
	fs.cp("apps/core/dist", "dist", { recursive: true }),
	...(!skipAssets ? [fs.cp("apps/core/audio", "dist/audio", { recursive: true })] : []),
	...(!skipAssets ? [fs.cp("apps/core/image", "dist/image", { recursive: true })] : []),
	...(!skipAssets ? [fs.cp("apps/core/extension", "dist/extension", { recursive: true })] : []),
	// Documentation and repository metadata.
	fs.cp("docs", "dist/docs", { recursive: true }),
	fs.cp(".nomedia", "dist/.nomedia"),
	fs.cp("LICENSE", "dist/LICENSE"),
	fs.cp("README.md", "dist/README.md"),
]);

await buildAssetManifest("dist", skipAssets ? ["apps/core:audio,image,extension"] : []);
await precompress("dist");
