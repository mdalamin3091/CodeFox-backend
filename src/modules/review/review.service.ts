import { Octokit } from "@octokit/rest";
import { GoogleGenAI } from "@google/genai";
import prisma from "../../config/prisma.js";
import config from "../../config/index.js";
import logger from "../../utils/logger.js";

// --------------------------------------------------------------------------
// Constants
// --------------------------------------------------------------------------

const REVIEW_MODEL = "gemini-2.5-flash";
const MAX_DIFF_CHARS = 12_000;
const MAX_FILE_CHARS = 6_000;
const MAX_FILES_IN_PROMPT = 5;

// --------------------------------------------------------------------------
// Types
// --------------------------------------------------------------------------

interface ReviewIssue {
  file: string;
  line?: string | number;
  severity: "high" | "medium" | "low";
  comment?: string;
  message?: string;
}

interface InlineComment {
  path: string;        // file path in the repo
  line: number;        // line number in the new (right) side of the diff
  severity: "high" | "medium" | "low";
  title: string;       // short one-line title
  body: string;        // detailed explanation
  suggestion?: string; // optional replacement code for GitHub suggestion block
}

interface ReviewResult {
  summary: string;
  issues: ReviewIssue[];
  inlineComments?: InlineComment[];
  suggestions?: string[];
  verdict?: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
}

// --------------------------------------------------------------------------
// Parse valid (path → line set) from stored PR files patches
// --------------------------------------------------------------------------

function getValidDiffLines(
  files: Array<{ filename: string; patch?: string }>,
): Map<string, Set<number>> {
  const result = new Map<string, Set<number>>();

  for (const file of files) {
    if (!file.patch) continue;
    const validLines = new Set<number>();
    let currentLine = 0;

    for (const line of file.patch.split("\n")) {
      const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunkMatch) {
        currentLine = parseInt(hunkMatch[1], 10) - 1;
        continue;
      }
      if (line.startsWith("-")) continue; // removed — no line number in new file
      currentLine++;
      validLines.add(currentLine); // added (+) and context lines are both valid
    }

    result.set(file.filename, validLines);
  }

  return result;
}

// --------------------------------------------------------------------------
// Format inline comment body (CodeRabbit style)
// --------------------------------------------------------------------------

function buildInlineCommentBody(c: InlineComment): string {
  const severityLabel =
    c.severity === "high"
      ? "⚠️ Potential issue | 🔴 High"
      : c.severity === "medium"
        ? "⚠️ Potential issue | 🟠 Major"
        : "💡 Suggestion | 🟢 Minor";

  const lines: string[] = [
    `${severityLabel}`,
    "",
    `**${c.title}**`,
    "",
    c.body,
  ];

  if (c.suggestion) {
    lines.push("", "```suggestion", c.suggestion, "```");
  }

  return lines.join("\n");
}

// --------------------------------------------------------------------------
// Build overall review body from structured output
// --------------------------------------------------------------------------

function buildReviewBody(review: ReviewResult, inlineCount: number): string {
  const lines: string[] = [];
  lines.push(`## 🤖 AI Code Review\n`);
  lines.push(`### Summary\n${review.summary}\n`);

  if (review.issues.length > 0) {
    lines.push(`### Issues`);
    for (const issue of review.issues) {
      const icon =
        issue.severity === "high"
          ? "🔴"
          : issue.severity === "medium"
            ? "🟡"
            : "🟢";
      const location = issue.file
        ? issue.line
          ? `\`${issue.file}:${issue.line}\``
          : `\`${issue.file}\``
        : "";
      lines.push(
        `- ${icon} **[${issue.severity.toUpperCase()}]** ${location} ${issue.comment ?? issue.message ?? ""}`,
      );
    }
    lines.push("");
  } else {
    lines.push(`### Issues\n_No issues found._\n`);
  }

  if (review.suggestions?.length) {
    lines.push(`### Suggestions`);
    for (const s of review.suggestions) lines.push(`- ${s}`);
    lines.push("");
  }

  if (inlineCount > 0) {
    lines.push(`_${inlineCount} inline comment(s) posted on specific lines._`);
  }

  return lines.join("\n");
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

async function fetchFileAtRef(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<string | null> {
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path, ref });
    if ("content" in data && typeof data.content === "string") {
      const raw = Buffer.from(data.content, "base64").toString("utf-8");
      return raw.length > MAX_FILE_CHARS
        ? raw.slice(0, MAX_FILE_CHARS) + "\n... (truncated)"
        : raw;
    }
    return null;
  } catch {
    return null;
  }
}

function buildPrompt(
  diff: string,
  files: Array<{ path: string; content: string }>,
): string {
  const filesSection = files.length
    ? files
        .map((f) => `### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``)
        .join("\n\n")
    : "_No relevant files fetched._";

  return `You are a senior software engineer performing a professional code review.

Pull Request Diff:
-------------------
${diff}

Relevant Existing Code Context:
-------------------------------
${filesSection}

Instructions:
- Detect bugs, performance issues, security vulnerabilities, breaking changes
- Identify specific lines in the diff that need attention
- For each issue on a specific line, include it in "inlineComments" with the exact line number from the diff
- Provide a short title, detailed explanation, and optionally a code suggestion (the replacement code only, no diff markers)
- Be concise and structured

Return ONLY valid JSON matching this exact shape:
{
  "summary": "2-3 sentence overview of what the PR does",
  "issues": [
    {
      "file": "path/to/file",
      "line": 15,
      "severity": "low|medium|high",
      "comment": "short description"
    }
  ],
  "inlineComments": [
    {
      "path": "path/to/file",
      "line": 15,
      "severity": "low|medium|high",
      "title": "Short descriptive title",
      "body": "Detailed explanation of the issue",
      "suggestion": "optional replacement code (omit field if no suggestion)"
    }
  ],
  "verdict": "APPROVE|REQUEST_CHANGES|COMMENT"
}`;
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
          user: {
            include: { accounts: { where: { providerId: "github" } } },
          },
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

    // 1. Fetch content of top relevant files at the PR's head commit
    const relevantFiles =
      (pr.relevantFiles as Array<{ filePath: string; score: number }> | null) ?? [];

    const fileContents: Array<{ path: string; content: string }> = [];
    for (const { filePath } of relevantFiles.slice(0, MAX_FILES_IN_PROMPT)) {
      const content = await fetchFileAtRef(octokit, owner, repoName, filePath, pr.headSha);
      if (content) fileContents.push({ path: filePath, content });
    }

    logger.info(
      `Review [PR #${pr.number}]: fetched ${fileContents.length} context files, building prompt`,
    );

    // 2. Build prompt
    const diff =
      pr.diff.length > MAX_DIFF_CHARS
        ? pr.diff.slice(0, MAX_DIFF_CHARS) + "\n... (truncated)"
        : pr.diff;
    const prompt = buildPrompt(diff, fileContents);

    // 3. Call Gemini
    const genAI = new GoogleGenAI({ apiKey: config.googleAiApiKey });
    const response = await genAI.models.generateContent({
      model: REVIEW_MODEL,
      contents: prompt,
      config: { responseMimeType: "application/json" },
    });

    const rawText = response.text ?? "";

    // 4. Parse JSON output
    let review: ReviewResult;
    try {
      review = JSON.parse(rawText) as ReviewResult;
    } catch {
      throw new Error(`Gemini returned non-JSON response: ${rawText.slice(0, 300)}`);
    }

    // 5. Build valid inline comments (only lines actually in the diff)
    const prFiles =
      (pr.files as Array<{ filename: string; patch?: string }> | null) ?? [];
    const validDiffLines = getValidDiffLines(prFiles);

    const inlineComments = (review.inlineComments ?? [])
      .filter((c) => {
        const validLines = validDiffLines.get(c.path);
        return validLines && validLines.has(Number(c.line));
      })
      .map((c) => ({
        path: c.path,
        line: Number(c.line),
        side: "RIGHT" as const,
        body: buildInlineCommentBody(c),
      }));

    logger.info(
      `Review [PR #${pr.number}]: ${inlineComments.length}/${review.inlineComments?.length ?? 0} inline comments are on valid diff lines`,
    );

    // 6. Build overall review body
    const reviewBody = buildReviewBody(review, inlineComments.length);

    // Validate verdict
    const validVerdicts = ["APPROVE", "REQUEST_CHANGES", "COMMENT"] as const;
    if (!review.verdict || !validVerdicts.includes(review.verdict)) {
      review.verdict = "COMMENT";
    }

    // 7. Post review to GitHub (with inline comments)
    // GitHub rejects REQUEST_CHANGES when reviewer is the PR author — fall back to COMMENT
    let ghReviewId: number;
    try {
      const ghReview = await octokit.rest.pulls.createReview({
        owner,
        repo: repoName,
        pull_number: pr.number,
        body: reviewBody,
        event: review.verdict,
        comments: inlineComments,
      });
      ghReviewId = ghReview.data.id;
    } catch (ghErr: unknown) {
      const msg = ghErr instanceof Error ? ghErr.message : String(ghErr);
      if (msg.toLowerCase().includes("own pull request")) {
        const ghReview = await octokit.rest.pulls.createReview({
          owner,
          repo: repoName,
          pull_number: pr.number,
          body: reviewBody,
          event: "COMMENT",
          comments: inlineComments,
        });
        ghReviewId = ghReview.data.id;
        review.verdict = "COMMENT";
      } else {
        throw ghErr;
      }
    }

    // 8. Persist to DB
    await prisma.pullRequest.update({
      where: { id: prId },
      data: {
        reviewStatus: "completed",
        reviewBody: reviewBody,
        reviewData: JSON.parse(JSON.stringify(review)),
        githubReviewId: BigInt(ghReviewId),
      },
    });

    logger.info(
      `Review [PR #${pr.number}]: DONE — verdict=${review.verdict}, inline=${inlineComments.length}, posted to GitHub (reviewId=${ghReviewId})`,
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
