import assert from "assert";

import { getArkEndpointModel, splitArkApiKeys } from "./volcengine-video.ts";

assert.deepStrictEqual(splitArkApiKeys(" key1, key2\nkey1\n\nkey3 "), [
  "key1",
  "key2",
  "key3",
]);
assert.deepStrictEqual(splitArkApiKeys(""), []);
assert.strictEqual(
  getArkEndpointModel("doubao-seedance-2-0-fast-260128", {
    baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3/contents/generations/tasks",
    apiKey: "key",
    label: "AgentPlan",
  }, "doubao-seedance-2-0-260128", "doubao-seedance-2-0-fast-260128"),
  "doubao-seedance-2.0-fast",
);
assert.strictEqual(
  getArkEndpointModel("doubao-seedance-2-0-260128", {
    baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3/contents/generations/tasks",
    apiKey: "key",
    label: "AgentPlan",
  }, "doubao-seedance-2-0-260128", "doubao-seedance-2-0-fast-260128"),
  "doubao-seedance-2.0",
);
assert.strictEqual(
  getArkEndpointModel("doubao-seedance-2-0-260128", {
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks",
    apiKey: "key",
    label: "Standard",
  }, "doubao-seedance-2-0-260128", "doubao-seedance-2-0-fast-260128"),
  "doubao-seedance-2-0-260128",
);

process.exit(0);
