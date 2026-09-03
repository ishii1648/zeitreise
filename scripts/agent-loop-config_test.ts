import { assertEquals, assertThrows } from "@std/assert";
import { parse } from "@std/yaml";

type Config = Record<string, unknown>;

const config = parse(await Deno.readTextFile(".agent-loop.yaml")) as Config;

function record(value: unknown, path: string): Config {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Config;
}

function strings(value: unknown, path: string): string[] {
  if (
    !Array.isArray(value) || !value.every((item) => typeof item === "string")
  ) {
    throw new Error(`${path} must be a string array`);
  }
  return value;
}

function requireValue(actual: unknown, expected: unknown, path: string): void {
  if (!Object.is(actual, expected)) {
    throw new Error(
      `${path} must be ${JSON.stringify(expected)}; got ${
        JSON.stringify(actual)
      }`,
    );
  }
}

function validateProductionConfig(root: Config): void {
  requireValue(root.version, 5, "version");

  const github = record(root.github, "github");
  requireValue(github.repo, "ishii1648/zeitreise", "github.repo");
  requireValue(github.repository_id, 1306205902, "github.repository_id");

  const queue = record(root.queue, "queue");
  requireValue(queue.concurrency, 1, "queue.concurrency");
  requireValue(
    queue.continue_after_needs_input,
    true,
    "queue.continue_after_needs_input",
  );

  const readyLabels = strings(github.ready_labels, "github.ready_labels");
  const excludeLabels = strings(github.exclude_labels, "github.exclude_labels");
  if (readyLabels.length === 0) {
    throw new Error("github.ready_labels must not be empty");
  }
  if (excludeLabels.length === 0) {
    throw new Error("github.exclude_labels must not be empty");
  }

  const runtimeLabels = [
    "running_label",
    "needs_input_label",
    "failed_label",
    "done_label",
  ].map((key) => {
    const value = github[key];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`github.${key} must be a non-empty string`);
    }
    return value;
  });
  const overlap = (left: string[], right: string[]) =>
    left.filter((label) => right.includes(label));
  if (overlap(readyLabels, excludeLabels).length > 0) {
    throw new Error(
      "github.ready_labels and github.exclude_labels must not overlap",
    );
  }
  if (overlap([...readyLabels, ...excludeLabels], runtimeLabels).length > 0) {
    throw new Error(
      "admission labels and runtime-owned labels must not overlap",
    );
  }

  const webhook = record(root.webhook, "webhook");
  requireValue(webhook.mode, "webhook", "webhook.mode");
  requireValue(
    record(root.watch, "watch").reconcile_interval,
    "60s",
    "watch.reconcile_interval",
  );
  requireValue(
    webhook.safety_sweep_interval,
    "15m",
    "webhook.safety_sweep_interval",
  );

  const network = record(
    record(root.worker, "worker").command_network,
    "worker.command_network",
  );
  requireValue(
    network.policy,
    "localhost-only",
    "worker.command_network.policy",
  );
  requireValue(network.proxy, true, "worker.command_network.proxy");
  const allowedHosts = strings(
    network.allowed_hosts,
    "worker.command_network.allowed_hosts",
  );
  assertEquals(
    new Set(allowedHosts),
    new Set(["localhost", "127.0.0.1"]),
    "worker.command_network.allowed_hosts must contain only localhost and 127.0.0.1",
  );
}

Deno.test("production agent-loop configuration satisfies its safety contract", () => {
  validateProductionConfig(config);
});

const mutationCases: Array<{
  name: string;
  expected: string;
  mutate(config: Config): void;
}> = [
  { name: "version", expected: "version", mutate: (c) => c.version = 4 },
  {
    name: "repository name",
    expected: "github.repo",
    mutate: (c) => record(c.github, "github").repo = "other/repo",
  },
  {
    name: "repository id",
    expected: "github.repository_id",
    mutate: (c) => record(c.github, "github").repository_id = 1,
  },
  {
    name: "concurrency",
    expected: "queue.concurrency",
    mutate: (c) => record(c.queue, "queue").concurrency = 2,
  },
  {
    name: "continue after needs-input",
    expected: "queue.continue_after_needs_input",
    mutate: (c) => record(c.queue, "queue").continue_after_needs_input = false,
  },
  {
    name: "empty ready labels",
    expected: "github.ready_labels must not be empty",
    mutate: (c) => record(c.github, "github").ready_labels = [],
  },
  {
    name: "empty exclude labels",
    expected: "github.exclude_labels must not be empty",
    mutate: (c) => record(c.github, "github").exclude_labels = [],
  },
  {
    name: "admission overlap",
    expected: "ready_labels and github.exclude_labels",
    mutate: (c) =>
      record(c.github, "github").exclude_labels = ["codex-loop:ready"],
  },
  {
    name: "runtime overlap",
    expected: "admission labels and runtime-owned labels",
    mutate: (c) =>
      record(c.github, "github").running_label = "codex-loop:ready",
  },
  {
    name: "webhook mode",
    expected: "webhook.mode",
    mutate: (c) => record(c.webhook, "webhook").mode = "poll",
  },
  {
    name: "reconcile interval",
    expected: "watch.reconcile_interval",
    mutate: (c) => record(c.watch, "watch").reconcile_interval = "30s",
  },
  {
    name: "safety sweep",
    expected: "webhook.safety_sweep_interval",
    mutate: (c) => record(c.webhook, "webhook").safety_sweep_interval = "30m",
  },
  {
    name: "network policy",
    expected: "worker.command_network.policy",
    mutate: (c) =>
      record(
        record(c.worker, "worker").command_network,
        "worker.command_network",
      ).policy = "off",
  },
  {
    name: "network proxy",
    expected: "worker.command_network.proxy",
    mutate: (c) =>
      record(
        record(c.worker, "worker").command_network,
        "worker.command_network",
      ).proxy = false,
  },
  {
    name: "allowed hosts",
    expected: "allowed_hosts must contain only",
    mutate: (c) =>
      record(
        record(c.worker, "worker").command_network,
        "worker.command_network",
      ).allowed_hosts = ["localhost", "example.com"],
  },
];

for (const testCase of mutationCases) {
  Deno.test(`rejects unsafe agent-loop config: ${testCase.name}`, () => {
    const mutated = structuredClone(config);
    testCase.mutate(mutated);
    assertThrows(
      () => validateProductionConfig(mutated),
      Error,
      testCase.expected,
    );
  });
}
