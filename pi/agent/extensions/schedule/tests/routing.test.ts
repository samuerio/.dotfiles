/**
 * routing.ts: scheduled runs follow `modes[currentMode].roles.subagents`.
 *
 * Every test points PI_CODING_AGENT_DIR at a scratch dir, so no real
 * modes.json is read.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach, beforeEach } from "node:test";

import { describeRoute, resolveSubagentRoute, routeFlags } from "../routing.ts";

let scratch: string;
let agentDir: string;

beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "schedule-routing-test-"));
    agentDir = join(scratch, "agent");
    mkdirSync(agentDir, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
    delete process.env.PI_CODING_AGENT_DIR;
    rmSync(scratch, { recursive: true, force: true });
});

function writeModes(dir: string, body: unknown): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "modes.json"), JSON.stringify(body, null, 2), "utf8");
}

const MODES = {
    version: 1,
    currentMode: "rush",
    modes: {
        rush: {
            roles: {
                main: { provider: "engy", modelId: "main-model", thinkingLevel: "high" },
                subagents: { provider: "engy", modelId: "sub-model", thinkingLevel: "medium" },
            },
        },
        smart: {
            roles: { subagents: { provider: "opencode-go", modelId: "glm-5.3-flash" } },
        },
    },
};

test("reads roles.subagents of the current mode, not roles.main", () => {
    writeModes(agentDir, MODES);
    const route = resolveSubagentRoute(scratch);
    assert.ok(route);
    assert.equal(route.provider, "engy");
    assert.equal(route.modelId, "sub-model");
    assert.equal(route.thinkingLevel, "medium");
    assert.equal(route.source, join(agentDir, "modes.json"));
});

test("project .pi/modes.json wins over the global one", () => {
    writeModes(agentDir, MODES);
    writeModes(join(scratch, "proj", ".pi"), {
        currentMode: "smart",
        modes: MODES.modes,
    });
    const route = resolveSubagentRoute(join(scratch, "proj"));
    assert.ok(route);
    assert.equal(route.provider, "opencode-go");
    assert.equal(route.modelId, "glm-5.3-flash");
    assert.equal(route.thinkingLevel, undefined);
});

test("a project modes.json without a usable pin falls through to the global one", () => {
    writeModes(agentDir, MODES);
    writeModes(join(scratch, "proj", ".pi"), { currentMode: "rush", modes: {} });
    const route = resolveSubagentRoute(join(scratch, "proj"));
    assert.ok(route);
    assert.equal(route.modelId, "sub-model");
});

test("no modes.json → undefined (caller falls back to pi's default)", () => {
    assert.equal(resolveSubagentRoute(scratch), undefined);
});

test("broken or partial modes.json is ignored, not thrown", () => {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "modes.json"), "{ not json", "utf8");
    assert.equal(resolveSubagentRoute(scratch), undefined);

    writeModes(agentDir, { modes: MODES.modes }); // no currentMode
    assert.equal(resolveSubagentRoute(scratch), undefined);

    writeModes(agentDir, { currentMode: "nope", modes: MODES.modes }); // unknown mode
    assert.equal(resolveSubagentRoute(scratch), undefined);

    writeModes(agentDir, {
        currentMode: "rush",
        modes: { rush: { roles: { subagents: { provider: "engy" } } } }, // no modelId
    });
    assert.equal(resolveSubagentRoute(scratch), undefined);
});

test("an invalid thinkingLevel is dropped, the model pin survives", () => {
    writeModes(agentDir, {
        currentMode: "rush",
        modes: {
            rush: {
                roles: {
                    subagents: { provider: "engy", modelId: "m", thinkingLevel: "turbo" },
                },
            },
        },
    });
    const route = resolveSubagentRoute(scratch);
    assert.ok(route);
    assert.equal(route.thinkingLevel, undefined);
    assert.deepEqual(routeFlags(route), ["--provider", "engy", "--model", "m"]);
});

test("routeFlags produces the pi CLI pin, and nothing when unpinned", () => {
    assert.deepEqual(routeFlags(undefined), []);
    assert.deepEqual(
        routeFlags({ provider: "engy", modelId: "deepseek-v4.1-flash", thinkingLevel: "high", source: "x" }),
        ["--provider", "engy", "--model", "deepseek-v4.1-flash", "--thinking", "high"],
    );
});

test("describeRoute names the pin or the fallback", () => {
    assert.match(describeRoute(undefined), /agent default/);
    assert.equal(
        describeRoute({ provider: "engy", modelId: "m", thinkingLevel: "high", source: "x" }),
        "engy/m:high (roles.subagents)",
    );
});
