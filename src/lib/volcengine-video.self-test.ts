import assert from "assert";

import { splitArkApiKeys } from "./volcengine-video.ts";

assert.deepStrictEqual(splitArkApiKeys(" key1, key2\nkey1\n\nkey3 "), [
  "key1",
  "key2",
  "key3",
]);
assert.deepStrictEqual(splitArkApiKeys(""), []);

process.exit(0);
