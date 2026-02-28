import { Octokit } from '@octokit/rest';
import { GoogleGenAI } from '@google/genai';
import prisma from '../../config/prisma.js';
import config from '../../config/index.js';
import logger from '../../utils/logger.js';
// --------------------------------------------------------------------------
// Constants
// --------------------------------------------------------------------------

const REVIEW_MODEL = 'gemini-2.5-flash';
const MAX_DIFF_CHARS = 12_000;
const MAX_FILE_CHARS = 6_000; 
const MAX_FILES_IN_PROMPT = 5;

// --------------------------------------------------------------------------
// Types
// --------------------------------------------------------------------------

interface ReviewIssue {
  file: string;
  severity: 'high' | 'medium' | 'low';
  message: string;
}

interface ReviewResult {
  summary: string;
  issues: ReviewIssue[];
  suggestions: string[];
  verdict: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
  reviewBody: string;
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
    if ('content' in data && typeof data.content === 'string') {
      const raw = Buffer.from(data.content, 'base64').toString('utf-8');
      return raw.length > MAX_FILE_CHARS ? raw.slice(0, MAX_FILE_CHARS) + '\n... (truncated)' : raw;
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
    ? files.map((f) => `### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``).join('\n\n')
    : '_No relevant files fetched._';

  return `You are an expert code reviewer. Analyze this pull request and return a structured JSON review.

## Pull Request Diff
\`\`\`diff
${diff}
\`\`\`

## Relevant Codebase Context
${filesSection}

## Instructions
Review the changes focusing on:
- Correctness and potential bugs
- Security vulnerabilities
- Performance concerns
- Code quality and maintainability
- Best practices for the language/framework

Respond with ONLY valid JSON (no markdown, no code fences) matching this exact shape:
{
  "summary": "2-3 sentence overview of what the PR does",
  "issues": [
    { "file": "path/to/file", "severity": "high|medium|low", "message": "description" }
  ],
  "suggestions": ["improvement suggestion 1", "suggestion 2"],
  "verdict": "APPROVE|REQUEST_CHANGES|COMMENT",
  "reviewBody": "Full markdown review suitable for a GitHub PR comment, using headings and bullet points"
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
            include: { accounts: { where: { providerId: 'github' } } },
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
    data: { reviewStatus: 'processing', reviewError: null },
  });

  try {
    const accessToken = pr.repository.user.accounts[0]?.accessToken;
    if (!accessToken) throw new Error('No GitHub access token found');

    const [owner, repoName] = pr.repository.fullName.split('/');
    const octokit = new Octokit({ auth: accessToken });

    // 1. Fetch content of top relevant files at the PR's head commit
    const relevantFiles = (
      pr.relevantFiles as Array<{ filePath: string; score: number }> | null
    ) ?? [];

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
      pr.diff.length > MAX_DIFF_CHARS ? pr.diff.slice(0, MAX_DIFF_CHARS) + '\n... (truncated)' : pr.diff;
    const prompt = buildPrompt(diff, fileContents);

    // 3. Call Gemini
    const genAI = new GoogleGenAI({ apiKey: config.googleAiApiKey });
    const response = await genAI.models.generateContent({
      model: REVIEW_MODEL,
      contents: prompt,
      config: { responseMimeType: 'application/json' },
    });

    const rawText = response.text ?? '';

    // 4. Parse JSON output
    let review: ReviewResult;
    try {
      review = JSON.parse(rawText) as ReviewResult;
    } catch {
      throw new Error(`Gemini returned non-JSON response: ${rawText.slice(0, 300)}`);
    }

    // Validate verdict value (GitHub only accepts these three)
    const validVerdicts = ['APPROVE', 'REQUEST_CHANGES', 'COMMENT'] as const;
    if (!validVerdicts.includes(review.verdict)) {
      review.verdict = 'COMMENT';
    }

    // 5. Post review to GitHub
    // GitHub rejects REQUEST_CHANGES when reviewer is the PR author — fall back to COMMENT
    let ghReviewId: number;
    try {
      const ghReview = await octokit.rest.pulls.createReview({
        owner,
        repo: repoName,
        pull_number: pr.number,
        body: review.reviewBody,
        event: review.verdict,
      });
      ghReviewId = ghReview.data.id;
    } catch (ghErr: unknown) {
      const msg = ghErr instanceof Error ? ghErr.message : String(ghErr);
      if (msg.toLowerCase().includes('own pull request')) {
        const ghReview = await octokit.rest.pulls.createReview({
          owner,
          repo: repoName,
          pull_number: pr.number,
          body: review.reviewBody,
          event: 'COMMENT',
        });
        ghReviewId = ghReview.data.id;
        review.verdict = 'COMMENT';
      } else {
        throw ghErr;
      }
    }

    // 6. Persist to DB
    await prisma.pullRequest.update({
      where: { id: prId },
      data: {
        reviewStatus: 'completed',
        reviewBody: review.reviewBody,
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
      data: { reviewStatus: 'failed', reviewError: message },
    });
  }
}
