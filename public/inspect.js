// "Inspect with" prompts for TDK output. Plain script with no imports: index.html loads it before app.js,
// and test/inspect.test.js runs it in a bare VM context.
const TDK_INSPECT = (() => {
  // The chat services take the prompt in the URL, so the pasted output is capped to keep the link usable.
  const MAX_OUTPUT_CHARS = 4000;
  // Same three services and brand colours as the "Review this PR in" badges in tdk-cli-core.
  const PROVIDERS = [
    { label: "Grok", color: "#111111", base: "https://grok.com/?q=", logo: '<path fill="currentColor" d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z"/>' },
    { label: "Claude", color: "#D97757", base: "https://claude.ai/new?q=", logo: '<path fill="currentColor" d="M17.304 3.541h-3.672l6.696 16.918H24Zm-10.608 0L0 20.459h3.744l1.37-3.553h7.005l1.369 3.553h3.744L10.536 3.541Zm-.371 10.223L8.616 7.82l2.291 5.945Z"/>' },
    { label: "Codex", color: "#10A37F", base: "https://chatgpt.com/?q=", logo: '<path fill="currentColor" d="M22.28 9.82a6 6 0 0 0-.52-4.91 6.05 6.05 0 0 0-6.51-2.9A6.07 6.07 0 0 0 4.98 4.18a6 6 0 0 0-4 2.9 6.05 6.05 0 0 0 .74 7.1 6 6 0 0 0 .51 4.91 6.05 6.05 0 0 0 6.52 2.9A6 6 0 0 0 13.26 24a6.06 6.06 0 0 0 5.77-4.21 6 6 0 0 0 4-2.9 6.06 6.06 0 0 0-.75-7.07z"/>' },
  ];
  const SECRET_NAME = "(secret|token|passw(or)?d|pwd|api[_-]?key|private[_-]?key|credential|authorization)";

  // Hide values that look like secrets before any text leaves the machine.
  function redact(text) {
    return String(text)
      .replace(/\b(bearer\s+)[\w.~+\/=-]+/gi, "$1[redacted]")
      .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s\/:@]+:)[^\s@\/]+@/gi, "$1[redacted]@")
      .replace(/\b(sk|pk|ghp|gho|xox[abprs])[-_][\w-]{12,}/g, "[redacted]")
      .replace(new RegExp(`(\\b[\\w.-]*${SECRET_NAME}[\\w.-]*["']?\\s*[=:]\\s*["']?)[^\\s"',;]+`, "gi"), "$1[redacted]");
  }

  // Keep the newest output, since the end of a log is what usually matters, and cut at a line break.
  function clip(text, max = MAX_OUTPUT_CHARS) {
    if (text.length <= max) return text;
    const tail = text.slice(-max);
    const newline = tail.indexOf("\n");
    return `(earlier output cut to keep the link short)\n${newline === -1 ? tail : tail.slice(newline + 1)}`;
  }

  function fence(text) {
    return `\`\`\`\n${String(text || "(no output)").replaceAll("```", "'''")}\n\`\`\``;
  }

  function logsPrompt({ project, path, resource, lines }) {
    return [
      `Inspect these recent logs from the "${resource}" resource in the TDK project "${project}" (${path}).`,
      "Find the root cause of any error, crash or restart loop, point to the lines that show it, and say what to check or change. If the logs look healthy, say so.",
      "",
      "Logs:",
      fence(clip(redact(lines.join("\n")))),
    ].join("\n");
  }

  function runPrompt({ project, path, action, exitCode, output }) {
    return [
      `TDK ran "${action}" for the project "${project}" (${path}) and it exited with code ${exitCode ?? "unknown"}.`,
      "Explain why it failed from this output, say what to change, and give the command to run next.",
      "",
      "Output:",
      fence(clip(redact(output || ""))),
    ].join("\n");
  }

  function doctorPrompt({ project, path, score, issues }) {
    const rank = { fail: 0, warning: 1 };
    const list = [...issues]
      .sort((left, right) => (rank[left.status] ?? 2) - (rank[right.status] ?? 2))
      .map((check) => `- [${check.status}] ${check.name}: ${redact(check.message)}${check.fix ? ` (suggested fix: ${redact(check.fix)})` : ""}`)
      .join("\n");
    return [
      `These checks from \`tdk doctor\` failed or warned for the TDK project "${project}" (${path}). Health score: ${score ?? "unknown"}/100.`,
      "For each one, explain what it means, the likely cause and the fix. Start with the failures.",
      "",
      list,
    ].join("\n");
  }

  function providerLinks(prompt) {
    const q = encodeURIComponent(prompt);
    return PROVIDERS.map((provider) => ({ ...provider, href: `${provider.base}${q}` }));
  }

  return { redact, logsPrompt, runPrompt, doctorPrompt, providerLinks };
})();
