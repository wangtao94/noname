import { register } from "node:module";
import { register as tsxRegister } from "tsx/esm/api";
import path from "node:path";
import { fileURLToPath } from "node:url";
export const coreRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../apps/core");
tsxRegister();
register("./hooks.js", import.meta.url, { data: { coreRoot } });
