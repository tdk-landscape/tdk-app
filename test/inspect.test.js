import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";

// inspect.js is a browser script, so run it in a bare VM context and take the TDK_INSPECT it defines.
const source = readFileSync(new URL("../public/inspect.js", import.meta.url), "utf8");
const inspect = runInNewContext(`${source}\nTDK_INSPECT`, {});

describe("inspect prompts", () => {
  it("redacts secret-looking values and keeps ordinary text", () => {
    const text = [
      "DATABASE_PASSWORD=hunter2",
      'config: {"api_key": "abc123xyz"}',
      "Authorization: Bearer eyJhbGciOi.payload.sig",
      "connecting to postgres://app:s3cret@localhost:5432/shop",
      "token sk-proj-abcdefghijklmnop1234",
      "listening on port 8080 (status ready)",
    ].join("\n");
    const out = inspect.redact(text);
    assert.doesNotMatch(out, /hunter2|abc123xyz|eyJhbGci|s3cret|sk-proj-abcdef/);
    assert.match(out, /DATABASE_PASSWORD=\[redacted\]/);
    assert.match(out, /postgres:\/\/app:\[redacted\]@localhost:5432\/shop/);
    assert.match(out, /listening on port 8080 \(status ready\)/);
  });

  it("keeps the newest log lines when the output is too long for the link", () => {
    const lines = Array.from({ length: 2000 }, (_, index) => `line ${index}`);
    const prompt = inspect.logsPrompt({ project: "shop", path: "~/shop", resource: "api", lines });
    assert.match(prompt, /earlier output cut/);
    assert.match(prompt, /line 1999/);
    assert.doesNotMatch(prompt, /line 0\n/);
    assert.ok(prompt.length < 4600, `prompt is ${prompt.length} characters`);
  });

  it("names the resource and project, and redacts the log text", () => {
    const prompt = inspect.logsPrompt({ project: "shop", path: "~/shop", resource: "api", lines: ["ERROR token=abc999 refused"] });
    assert.match(prompt, /"api" resource in the TDK project "shop" \(~\/shop\)/);
    assert.match(prompt, /ERROR token=\[redacted\] refused/);
  });

  it("builds the failed-run prompt with the exit code and redacted output", () => {
    const prompt = inspect.runPrompt({ project: "shop", path: "~/shop", action: "verify", exitCode: 2, output: "password=oops\nerror: drift in api" });
    assert.match(prompt, /exited with code 2/);
    assert.match(prompt, /error: drift in api/);
    assert.doesNotMatch(prompt, /oops/);
  });

  it("lists failed doctor checks before warnings, with their fixes", () => {
    const prompt = inspect.doctorPrompt({
      project: "shop",
      path: "~/shop",
      score: 72,
      issues: [
        { name: "Ports", status: "warning", message: "3000 in use", fix: "" },
        { name: "Docker", status: "fail", message: "daemon not running", fix: "open Docker Desktop" },
      ],
    });
    assert.ok(prompt.indexOf("[fail] Docker") < prompt.indexOf("[warning] Ports"));
    assert.match(prompt, /Health score: 72\/100/);
    assert.match(prompt, /suggested fix: open Docker Desktop/);
  });

  it("links the same three services as the PR review buttons, with the prompt encoded", () => {
    const prompt = 'Inspect "api" & 100% of the logs\nthen fix it';
    const links = inspect.providerLinks(prompt);
    assert.equal(links.map((link) => link.label).join(","), "Grok,Claude,Codex");
    assert.equal(links.map((link) => link.href.split("?")[0]).join(","), "https://grok.com/,https://claude.ai/new,https://chatgpt.com/");
    for (const link of links) assert.equal(decodeURIComponent(link.href.slice(link.href.indexOf("?q=") + 3)), prompt);
  });

  it("builds the starter prompt with the TDK commands and architecture rules", () => {
    const prompt = inspect.buildPrompt();
    for (const command of ["tdk project", "tdk resource", "tdk stack", "tdk up", "tdk down --force", "tdk config regenerate", "tdk networks", "tdk doctor"]) {
      assert.ok(prompt.includes(command), `missing ${command}`);
    }
    assert.match(prompt, /Project > Stack > Resource/);
    assert.match(prompt, /\.tdk\/project\.json/);
    assert.match(prompt, /service\.json, which is the source of truth/);
    assert.match(prompt, /never edit generated output/);
    assert.match(prompt, /Wait for my OK/);
  });

  it("keeps the starter prompt short enough to fit in a chat link", () => {
    const prompt = inspect.buildPrompt();
    assert.ok(prompt.length < 3500, `prompt is ${prompt.length} characters`);
    const longest = Math.max(...inspect.providerLinks(prompt).map((link) => link.href.length));
    assert.ok(longest < 9000, `link is ${longest} characters`);
  });

  it("contains no user or machine data", () => {
    const prompt = inspect.buildPrompt();
    assert.doesNotMatch(prompt, /\/Users\/|\/home\/|@[a-z0-9-]+\.[a-z]{2,}|password|token/i);
  });
});
