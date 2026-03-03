import { Octokit } from "@octokit/rest";
import { GoogleGenAI } from "@google/genai";
import prisma from "../../config/prisma.js";
import config from "../../config/index.js";
import logger from "../../utils/logger.js";

// --------------------------------------------------------------------------
// Constants
// --------------------------------------------------------------------------

const REVIEW_MODEL = "gemini-2.5-flash";
const MAX_PATCH_CHARS = 8_000;  // per-file patch truncation
const CHUNK_SIZE = 5;           // files per Gemini call
const MAX_CONCURRENT = 3;       // max parallel Gemini calls

// Extensions to skip — no logic to review
const SKIP_EXTENSIONS = new Set([
  ".lock", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".webp",
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".min.js", ".min.css", ".map",
  ".pdf", ".zip", ".tar", ".gz",
  ".gitignore", ".md",
]);

// --------------------------------------------------------------------------
// Types
// --------------------------------------------------------------------------

interface PrFile {
  filename: string;
  status: string;
  patch?: string;
  additions: number;
  deletions: number;
}

interface ReviewIssue {
  file: string;
  line?: string | number;
  severity: "high" | "medium" | "low";
  comment?: string;
}

interface InlineComment {
  path: string;
  line: number;
  severity: "high" | "medium" | "low";
  title: string;
  body: string;
  proposedFix?: string;   // diff-style snippet (- old / + new)
  suggestion?: string;    // full replacement for GitHub suggestion block
  agentPrompt?: string;   // instruction for AI agents
}

interface ChunkResult {
  issues: ReviewIssue[];
  inlineComments: InlineComment[];
}

// --------------------------------------------------------------------------
// File filtering & prioritisation
// --------------------------------------------------------------------------

function shouldSkipForReview(filename: string): boolean {
  const lower = filename.toLowerCase();
  for (const ext of SKIP_EXTENSIONS) {
    if (lower.endsWith(ext)) return true;
  }
  // Skip generated / lock files by name
  const base = lower.split("/").pop() ?? lower;
  if (
    base === "package-lock.json" ||
    base === "yarn.lock" ||
    base === "pnpm-lock.yaml" ||
    base === "bun.lockb" ||
    base === "go.sum" ||
    base === "cargo.lock"
  )
    return true;
  // Skip snapshot / fixture files
  if (lower.includes("__snapshots__") || lower.includes(".snap")) return true;
  return false;
}

function filePriority(filename: string): number {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const code = ["ts", "tsx", "js", "jsx", "py", "go", "java", "rs", "cpp", "c", "cs", "rb", "php", "swift", "kt"];
  const config = ["json", "yaml", "yml", "toml", "env", "config"];
  if (code.includes(ext)) return 3;
  if (config.includes(ext)) return 1;
  return 2;
}

// --------------------------------------------------------------------------
// Parse valid diff lines per file (path → Set<lineNumber>)
// --------------------------------------------------------------------------

function getValidDiffLines(
  files: Array<{ filename: string; patch?: string }>,
): Map<string, Set<number>> {
  const result = new Map<string, Set<number>>();
  for (const file of files) {
    if (!file.patch) continue;
    const valid = new Set<number>();
    let cur = 0;
    for (const line of file.patch.split("\n")) {
      const m = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) { cur = parseInt(m[1], 10) - 1; continue; }
      if (line.startsWith("-")) continue;
      valid.add(++cur);
    }
    result.set(file.filename, valid);
  }
  return result;
}

// --------------------------------------------------------------------------
// Inline comment body formatter (CodeRabbit style)
// --------------------------------------------------------------------------

function buildInlineCommentBody(c: InlineComment): string {
  const label =
    c.severity === "high"
      ? "⚠️ Potential issue | 🔴 High"
      : c.severity === "medium"
        ? "⚠️ Potential issue | 🟠 Major"
        : "⚠️ Potential issue | 🟡 Minor";

  const lines: string[] = [label, "", `**${c.title}**`, "", c.body];

  if (c.proposedFix) {
    lines.push("", "🛡️ **Proposed fix**", "```diff", c.proposedFix, "```");
  }

  if (c.suggestion) {
    lines.push(
      "",
      "📝 **Committable suggestion**",
      "> ‼️ **IMPORTANT**",
      "> Carefully review the code before committing. Ensure that it accurately replaces the highlighted code, contains no missing lines, and has no issues with indentation. Thoroughly test & benchmark the code to ensure it meets the requirements.",
      "",
      "```suggestion",
      c.suggestion,
      "```",
    );
  }

  if (c.agentPrompt) {
    lines.push("", "🤖 **Prompt for AI Agents**", c.agentPrompt);
  }

  return lines.join("\n");
}

// --------------------------------------------------------------------------
// Overall review body
// --------------------------------------------------------------------------

function buildReviewBody(
  summary: string,
  issues: ReviewIssue[],
  inlineCount: number,
  verdict: string,
): string {
  const lines: string[] = [`## 🤖 CodeFox AI Review\n`, `### Summary\n${summary}\n`];

  if (issues.length > 0) {
    lines.push("### Issues");
    for (const issue of issues) {
      const icon = issue.severity === "high" ? "🔴" : issue.severity === "medium" ? "🟡" : "🟢";
      const loc = issue.file
        ? issue.line ? `\`${issue.file}:${issue.line}\`` : `\`${issue.file}\``
        : "";
      lines.push(`- ${icon} **[${issue.severity.toUpperCase()}]** ${loc} ${issue.comment ?? ""}`);
    }
    lines.push("");
  } else {
    lines.push("### Issues\n_No issues found._\n");
  }

  if (inlineCount > 0) {
    lines.push(`_${inlineCount} inline comment(s) posted on specific lines._\n`);
  }

  const verdictLine =
    verdict === "APPROVE"
      ? "✅ **Verdict: APPROVE** — Looks good to merge."
      : verdict === "REQUEST_CHANGES"
        ? "❌ **Verdict: REQUEST CHANGES** — Issues need to be addressed."
        : "💬 **Verdict: COMMENT** — Review notes posted.";
  lines.push(verdictLine);

  return lines.join("\n");
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------


function parseJson<T>(raw: string): T {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  return JSON.parse(cleaned) as T;
}

// --------------------------------------------------------------------------
// Per-chunk Gemini call
// --------------------------------------------------------------------------

async function processFileChunk(
  files: PrFile[],
  genAI: GoogleGenAI,
  logger_: typeof logger,
): Promise<ChunkResult> {
  const filesSection = files
    .map((f) => {
      const patch = f.patch
        ? f.patch.length > MAX_PATCH_CHARS
          ? f.patch.slice(0, MAX_PATCH_CHARS) + "\n... (truncated)"
          : f.patch
        : "(no patch)";
      return `### ${f.filename} (+${f.additions} -${f.deletions})\n\`\`\`diff\n${patch}\n\`\`\``;
    })
    .join("\n\n");

  const prompt = `You are reviewing specific files in a pull request. Add an inline comment when you find ANY of the following:
- Bugs, errors, null-dereferences, or potential crashes
- Security vulnerabilities (XSS, SQL injection, hardcoded secrets, etc.)
- Major code improvements: significantly better algorithm, missing error handling, poor async/await usage, unnecessary re-renders, N+1 queries, memory leaks, race conditions, missing input validation, or any pattern that will clearly cause problems at scale
Do NOT comment on: minor style preferences, naming conventions, formatting, or trivial suggestions.

Files changed:
${filesSection}

Return ONLY valid JSON:
{
  "issues": [
    { "file": "path", "line": 0, "severity": "high|medium|low", "comment": "short description" }
  ],
  "inlineComments": [
    {
      "path": "path/to/file",
      "line": 0,
      "severity": "high|medium|low",
      "title": "Short descriptive title of the problem",
      "body": "Detailed explanation of why this is a problem",
      "proposedFix": "- old line\\n+ fixed line\\n  context line",
      "suggestion": "full replacement code block (no diff markers)",
      "agentPrompt": "In path/to/file at line N, find X and replace with Y because Z"
    }
  ]
}`;

  try {
    const response = await genAI.models.generateContent({
      model: REVIEW_MODEL,
      contents: prompt,
      config: { responseMimeType: "application/json" },
    });
    const result = parseJson<ChunkResult>(response.text ?? "");
    return {
      issues: result.issues ?? [],
      inlineComments: result.inlineComments ?? [],
    };
  } catch (err) {
    logger_.warn(`Review chunk failed for [${files.map((f) => f.filename).join(", ")}]: ${err}`);
    return { issues: [], inlineComments: [] };
  }
}

// --------------------------------------------------------------------------
// Summary + verdict from merged results
// --------------------------------------------------------------------------

async function generateSummary(
  issues: ReviewIssue[],
  totalFiles: number,
  genAI: GoogleGenAI,
): Promise<{ summary: string; verdict: "APPROVE" | "REQUEST_CHANGES" | "COMMENT" }> {
  const issueList = issues.length
    ? issues.map((i) => `- [${i.severity}] ${i.file}: ${i.comment}`).join("\n")
    : "No issues found.";

  const prompt = `You reviewed a pull request spanning ${totalFiles} changed files and found these issues:

${issueList}

Write a 2-3 sentence overall summary and choose a verdict.

Return ONLY valid JSON:
{ "summary": "...", "verdict": "APPROVE|REQUEST_CHANGES|COMMENT" }`;

  try {
    const response = await genAI.models.generateContent({
      model: REVIEW_MODEL,
      contents: prompt,
      config: { responseMimeType: "application/json" },
    });
    const result = parseJson<{ summary: string; verdict: "APPROVE" | "REQUEST_CHANGES" | "COMMENT" }>(
      response.text ?? "",
    );
    return {
      summary: result.summary ?? "Review completed.",
      verdict: ["APPROVE", "REQUEST_CHANGES", "COMMENT"].includes(result.verdict)
        ? result.verdict
        : "COMMENT",
    };
  } catch {
    const highCount = issues.filter((i) => i.severity === "high").length;
    return {
      summary: `Reviewed ${totalFiles} files. Found ${issues.length} issue(s).`,
      verdict: highCount > 0 ? "REQUEST_CHANGES" : issues.length > 0 ? "COMMENT" : "APPROVE",
    };
  }
}

// --------------------------------------------------------------------------
// Main review generation
// --------------------------------------------------------------------------

export async function generatePrReview(prId: string): Promise<void> {
  const pr = await prisma.pullRequest.findUnique({
    where: { id: prId },
    include: {
      repository: {
        include: {
          user: { include: { accounts: { where: { providerId: "github" } } } },
        },
      },
    },
  });

  if (!pr?.diff) {
    logger.warn(`Review [prId=${prId}]: no diff available, skipping`);
    return;
  }

  await prisma.pullRequest.update({
    where: { id: prId },
    data: { reviewStatus: "processing", reviewError: null },
  });

  try {
    const accessToken = pr.repository.user.accounts[0]?.accessToken;
    if (!accessToken) throw new Error("No GitHub access token found");

    const [owner, repoName] = pr.repository.fullName.split("/");
    const octokit = new Octokit({ auth: accessToken });
    const genAI = new GoogleGenAI({ apiKey: config.googleAiApiKey });

    // 1. Parse changed files — filter and prioritise
    const allPrFiles = (pr.files as PrFile[] | null) ?? [];
    const reviewableFiles = allPrFiles
      .filter((f) => f.status !== "removed" && f.patch && !shouldSkipForReview(f.filename))
      .sort((a, b) => filePriority(b.filename) - filePriority(a.filename));

    logger.info(
      `Review [PR #${pr.number}]: ${reviewableFiles.length}/${allPrFiles.length} files are reviewable`,
    );

    // 2. Chunk files
    const chunks: PrFile[][] = [];
    for (let i = 0; i < reviewableFiles.length; i += CHUNK_SIZE) {
      chunks.push(reviewableFiles.slice(i, i + CHUNK_SIZE));
    }

    // 3. Process chunks with concurrency limit
    const allIssues: ReviewIssue[] = [];
    const allInlineComments: InlineComment[] = [];

    for (let i = 0; i < chunks.length; i += MAX_CONCURRENT) {
      const batch = chunks.slice(i, i + MAX_CONCURRENT);
      const results = await Promise.all(
        batch.map((chunk) => processFileChunk(chunk, genAI, logger)),
      );
      for (const r of results) {
        allIssues.push(...r.issues);
        allInlineComments.push(...r.inlineComments);
      }
      logger.info(
        `Review [PR #${pr.number}]: processed chunks ${i + 1}–${Math.min(i + MAX_CONCURRENT, chunks.length)} of ${chunks.length}`,
      );
    }

    // 4. Filter inline comments to lines that actually exist in the diff
    const validDiffLines = getValidDiffLines(allPrFiles);
    const inlineComments = allInlineComments.filter((c) => {
      const valid = validDiffLines.get(c.path);
      return valid && valid.has(Number(c.line));
    });

    logger.info(
      `Review [PR #${pr.number}]: ${allIssues.length} issues, ${inlineComments.length}/${allInlineComments.length} valid inline comments`,
    );

    // 5. Generate overall summary
    const { summary, verdict } = await generateSummary(allIssues, reviewableFiles.length, genAI);

    // 6. Build review body
    const reviewBody = buildReviewBody(summary, allIssues, inlineComments.length, verdict);

    // 7. Format inline comments for GitHub
    const githubComments = inlineComments.map((c) => ({
      path: c.path,
      line: Number(c.line),
      side: "RIGHT" as const,
      body: buildInlineCommentBody(c),
    }));

    // 8. Post review to GitHub
    // Also fetch relevant context files for the review (used in step 3 above, passed below for reference)
    let ghReviewId: number;
    const postReview = async (event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT") => {
      const ghReview = await octokit.rest.pulls.createReview({
        owner,
        repo: repoName,
        pull_number: pr.number,
        body: reviewBody,
        event,
        comments: githubComments,
      });
      return ghReview.data.id;
    };

    try {
      ghReviewId = await postReview(verdict);
    } catch (ghErr: unknown) {
      const msg = ghErr instanceof Error ? ghErr.message : String(ghErr);
      if (msg.toLowerCase().includes("own pull request")) {
        ghReviewId = await postReview("COMMENT");
      } else {
        throw ghErr;
      }
    }

    // 9. Persist to DB
    await prisma.pullRequest.update({
      where: { id: prId },
      data: {
        reviewStatus: "completed",
        reviewBody,
        reviewData: JSON.parse(
          JSON.stringify({ summary, verdict, issues: allIssues, inlineComments }),
        ),
        githubReviewId: BigInt(ghReviewId),
      },
    });

    logger.info(
      `Review [PR #${pr.number}]: DONE — verdict=${verdict}, issues=${allIssues.length}, inline=${inlineComments.length}, chunks=${chunks.length} (reviewId=${ghReviewId})`,
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Review [prId=${prId}]: FAILED — ${message}`);
    await prisma.pullRequest.update({
      where: { id: prId },
      data: { reviewStatus: "failed", reviewError: message },
    });
  }
}
