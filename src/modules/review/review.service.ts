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

interface ReviewResult {
  summary: string;
  issues: ReviewIssue[];
  suggestions?: string[];
  verdict?: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  reviewBody?: string;
}

function buildReviewBody(review: ReviewResult): string {
  const lines: string[] = [];
  lines.push(`## 🤖 AI Code Review\n`);
  lines.push(`### Summary\n${review.summary}\n`);

  if (review.issues.length > 0) {
    lines.push(`### Issues`);
    for (const issue of review.issues) {
      const icon = issue.severity === 'high' ? '🔴' : issue.severity === 'medium' ? '🟡' : '🟢';
      const location = issue.file ? (issue.line ? `\`${issue.file}:${issue.line}\`` : `\`${issue.file}\``) : '';
      lines.push(`- ${icon} **[${issue.severity.toUpperCase()}]** ${location} ${issue.comment ?? issue.message ?? ''}`);
    }
    lines.push('');
  } else {
    lines.push(`### Issues\n_No issues found._\n`);
  }

  if (review.suggestions?.length) {
    lines.push(`### Suggestions`);
    for (const s of review.suggestions) lines.push(`- ${s}`);
    lines.push('');
  }

  return lines.join('\n');
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

// function buildPrompt(
//   diff: string,
//   files: Array<{ path: string; content: string }>,
// ): string {
// const filesSection = files.length
//   ? files.map((f) => `### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``).join('\n\n')
//   : '_No relevant files fetched._';

//   return `You are an expert code reviewer. Analyze this pull request and return a structured JSON review.

// ## Pull Request Diff
// \`\`\`diff
// ${diff}
// \`\`\`

// ## Relevant Codebase Context
// ${filesSection}

// ## Instructions
// Review the changes focusing on:
// - Correctness and potential bugs
// - Security vulnerabilities
// - Performance concerns
// - Code quality and maintainability
// - Best practices for the language/framework

// Respond with ONLY valid JSON (no markdown, no code fences) matching this exact shape:
// {
//   "summary": "2-3 sentence overview of what the PR does",
//   "issues": [
//     { "file": "path/to/file", "severity": "high|medium|low", "message": "description" }
//   ],
//   "suggestions": ["improvement suggestion 1", "suggestion 2"],
//   "verdict": "APPROVE|REQUEST_CHANGES|COMMENT",
//   "reviewBody": "Full markdown review suitable for a GitHub PR comment, using headings and bullet points"
// }`;
// }

function buildPrompt(
  diff: string,
  files: Array<{ path: string; content: string }>,
) {
  const filesSection = files.length
    ? files
        .map((f) => `### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``)
        .join("\n\n")
    : "_No relevant files fetched._";

  return `
You are a senior software engineer performing a professional code review.

Pull Request Diff:
-------------------
${diff}

Relevant Existing Code Context:
-------------------------------
${filesSection}

Instructions:
- Detect bugs
- Detect performance issues
- Detect security vulnerabilities
- Detect breaking changes
- Suggest improvements
- Be concise and structured

Return JSON:
{
  "summary": "...",
  "issues": [
    {
      "file": "",
      "line": "",
      "severity": "low | medium | high",
      "comment": ""
    }
  ]
}
`;
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
      (pr.relevantFiles as Array<{ filePath: string; score: number }> | null) ??
      [];

    const fileContents: Array<{ path: string; content: string }> = [];
    for (const { filePath } of relevantFiles.slice(0, MAX_FILES_IN_PROMPT)) {
      const content = await fetchFileAtRef(
        octokit,
        owner,
        repoName,
        filePath,
        pr.headSha,
      );
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
      throw new Error(
        `Gemini returned non-JSON response: ${rawText.slice(0, 300)}`,
      );
    }

    // Build review body from structured output if not provided
    const reviewBody = review.reviewBody || buildReviewBody(review);

    // Validate verdict value (GitHub only accepts these three)
    const validVerdicts = ["APPROVE", "REQUEST_CHANGES", "COMMENT"] as const;
    if (!review.verdict || !validVerdicts.includes(review.verdict)) {
      review.verdict = "COMMENT";
    }

    // 5. Post review to GitHub
    // GitHub rejects REQUEST_CHANGES when reviewer is the PR author — fall back to COMMENT
    let ghReviewId: number;
    try {
      const ghReview = await octokit.rest.pulls.createReview({
        owner,
        repo: repoName,
        pull_number: pr.number,
        body: reviewBody,
        event: review.verdict,
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
        });
        ghReviewId = ghReview.data.id;
        review.verdict = "COMMENT";
      } else {
        throw ghErr;
      }
    }

    // 6. Persist to DB
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
      `Review [PR #${pr.number}]: DONE — verdict=${review.verdict}, issues=${review.issues.length}, posted to GitHub (reviewId=${ghReviewId})`,
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
