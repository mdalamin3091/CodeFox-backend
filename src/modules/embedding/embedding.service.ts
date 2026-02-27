import { Pinecone } from '@pinecone-database/pinecone';
import { Octokit } from '@octokit/rest';
import prisma from '../../config/prisma.js';
import config from '../../config/index.js';
import logger from '../../utils/logger.js';
// import { GoogleGenerativeAI } from "@google/generative-ai";
import {GoogleGenAI} from '@google/genai';


// --------------------------------------------------------------------------
// File exclusion rules
// --------------------------------------------------------------------------

const EXCLUDED_DIRS = new Set([
  'node_modules', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit',
  '__pycache__', '.git', 'vendor', 'coverage', '.nyc_output', '.cache',
  'tmp', 'temp', '.turbo', '.vercel', 'target', 'bin', 'obj',
  '.idea', '.vscode', 'venv', '.venv', '.tox', '.pytest_cache',
  'Pods', 'DerivedData', '.gradle', '.mvn',
]);

const EXCLUDED_FILENAMES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb',
  'Cargo.lock', 'poetry.lock', 'Gemfile.lock', 'composer.lock',
  'Pipfile.lock', 'go.sum',
]);

const EXCLUDED_EXTENSIONS = new Set([
  // Images
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp', '.avif', '.bmp', '.tiff',
  // Video / audio
  '.mp4', '.mp3', '.wav', '.avi', '.mov', '.mkv', '.flac', '.ogg',
  // Documents
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  // Compiled / binary
  '.class', '.pyc', '.pyo', '.o', '.obj', '.so', '.dll', '.exe', '.bin', '.wasm', '.jar',
  // Archives
  '.zip', '.tar', '.gz', '.rar', '.7z', '.bz2',
  // Fonts
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
  // Minified
  '.min.js', '.min.css',
  // Source maps
  '.map',
  // Env (security — never embed)
  '.env', '.pem', '.key', '.cert', '.p12', '.pfx',
]);

/**
 * Helper to strip Git metadata and symbols from a diff 
 * to improve embedding accuracy.
 */
function cleanDiff(diff: string): string {
  return diff
    .split('\n')
    // Remove lines starting with diff markers or location headers
    .filter(line => !line.startsWith('diff --git') && !line.startsWith('index ') && !line.startsWith('+++') && !line.startsWith('---') && !line.startsWith('@@'))
    // Remove the leading + and - symbols from code lines
    .map(line => line.replace(/^[+-]/, ''))
    .join('\n')
    .trim();
}

// --------------------------------------------------------------------------
// Gemini embedding via REST (v1) — both official SDKs default to v1beta
// which does not expose text-embedding-004
// --------------------------------------------------------------------------

async function batchEmbed(texts: string[], apiKey: string): Promise<number[][]> {
  const genAI = new GoogleGenAI({ apiKey });
  const result = await genAI.models.embedContent({
    model: 'gemini-embedding-001',
    contents: texts,
  });

  if (!result.embeddings) throw new Error('No embeddings returned from Gemini');
  return result.embeddings.map((e) => e.values ?? []);
}

const MAX_FILE_BYTES = 150_000;    // skip files > 150 KB
const MAX_CONTENT_CHARS = 10_000; // truncate content at ~2500 tokens
const EMBED_BATCH = 50;           // embedMany batch size
const PINECONE_BATCH = 100;       // Pinecone upsert batch size
const FETCH_CONCURRENCY = 8;      // parallel blob fetches

function shouldExclude(filePath: string, sizeBytes?: number): boolean {
  if (sizeBytes !== undefined && sizeBytes > MAX_FILE_BYTES) return true;

  const parts = filePath.split('/');
  const filename = parts[parts.length - 1];

  // Exclude directories in path
  for (let i = 0; i < parts.length - 1; i++) {
    if (EXCLUDED_DIRS.has(parts[i])) return true;
  }

  // Hidden files (except useful ones like .gitignore, .env.example)
  if (
    filename.startsWith('.') &&
    !filename.startsWith('.env.example') &&
    filename !== '.gitignore' &&
    filename !== '.gitattributes' &&
    filename !== '.editorconfig' &&
    filename !== '.prettierrc' &&
    filename !== '.eslintrc'
  ) {
    return true;
  }

  if (EXCLUDED_FILENAMES.has(filename)) return true;

  // Extension check (handle compound extensions like .min.js)
  const lower = filename.toLowerCase();
  for (const ext of EXCLUDED_EXTENSIONS) {
    if (lower.endsWith(ext)) return true;
  }

  return false;
}

// --------------------------------------------------------------------------
// Fetch file content in parallel batches
// --------------------------------------------------------------------------

async function fetchFilesInBatches(
  octokit: Octokit,
  owner: string,
  repo: string,
  files: Array<{ path?: string; sha?: string }>,
): Promise<Array<{ path: string; content: string }>> {
  const results: Array<{ path: string; content: string }> = [];

  for (let i = 0; i < files.length; i += FETCH_CONCURRENCY) {
    const batch = files.slice(i, i + FETCH_CONCURRENCY);
    const fetched = await Promise.all(
      batch.map(async (file) => {
        try {
          const { data: blob } = await octokit.git.getBlob({
            owner,
            repo,
            file_sha: file.sha!,
          });
          const raw = Buffer.from(blob.content, 'base64').toString('utf-8');
          // Skip binary content (null bytes are a good signal)
          if (raw.includes('\0')) return null;
          const content = raw.length > MAX_CONTENT_CHARS ? raw.slice(0, MAX_CONTENT_CHARS) : raw;
          return { path: file.path!, content };
        } catch {
          return null;
        }
      }),
    );
    results.push(...fetched.filter((r): r is NonNullable<typeof r> => r !== null));
  }

  return results;
}

// --------------------------------------------------------------------------
// Main embedding job
// --------------------------------------------------------------------------

export async function embedRepository(repoId: string): Promise<void> {
  await prisma.repository.update({
    where: { id: repoId },
    data: { embeddingStatus: 'processing', embeddingError: null },
  });

  try {
    const repo = await prisma.repository.findUnique({
      where: { id: repoId },
      include: {
        user: { include: { accounts: { where: { providerId: 'github' } } } },
      },
    });

    if (!repo) throw new Error('Repository not found');

    const accessToken = repo.user.accounts[0]?.accessToken;
    if (!accessToken) throw new Error('No GitHub access token found');

    const [owner, repoName] = repo.fullName.split('/');
    const octokit = new Octokit({ auth: accessToken });

    // 1. Fetch complete file tree from default branch (single API call)
    logger.info(`Embedding [${repo.fullName}]: fetching file tree from "${repo.defaultBranch}"`);
    const { data: treeData } = await octokit.git.getTree({
      owner,
      repo: repoName,
      tree_sha: repo.defaultBranch,
      recursive: '1',
    });

    const eligibleFiles = (treeData.tree ?? []).filter(
      (item) =>
        item.type === 'blob' &&
        item.path &&
        item.sha &&
        !shouldExclude(item.path, item.size),
    );

    logger.info(`Embedding [${repo.fullName}]: ${eligibleFiles.length} eligible files (${treeData.tree?.length ?? 0} total)`);

    if (eligibleFiles.length === 0) {
      await prisma.repository.update({
        where: { id: repoId },
        data: { embeddingStatus: 'completed', embeddedAt: new Date() },
      });
      return;
    }

    // 2. Fetch file contents
    const fileContents = await fetchFilesInBatches(octokit, owner, repoName, eligibleFiles);
    logger.info(`Embedding [${repo.fullName}]: fetched ${fileContents.length} files`);

    // 3. Build documents: "File: <path>\n\n<content>"
    const documents = fileContents.map((f) => ({
      id: `${repoId}:${f.path}`,
      text: `File: ${f.path}\n\n${f.content}`,
      metadata: {
        repoId,
        repositoryFullName: repo.fullName,
        filePath: f.path,
        language: f.path.includes('.') ? f.path.split('.').pop()! : 'unknown',
      },
    }));

    // 4. Embed using Gemini text-embedding-004 via direct REST (v1)
    const allVectors: Array<{
      id: string;
      values: number[];
      metadata: Record<string, string>;
    }> = [];

    for (let i = 0; i < documents.length; i += EMBED_BATCH) {
      const batch = documents.slice(i, i + EMBED_BATCH);
      const vectors = await batchEmbed(
        batch.map((d) => d.text),
        config.googleAiApiKey,
      );
      for (let j = 0; j < batch.length; j++) {
        allVectors.push({
          id: batch[j].id,
          values: vectors[j],
          metadata: batch[j].metadata,
        });
      }
      logger.info(
        `Embedding [${repo.fullName}]: embedded ${Math.min(i + EMBED_BATCH, documents.length)}/${documents.length} files`,
      );
    }

    // 5. Upsert to Pinecone (namespace = repoId for easy deletion)
    const pinecone = new Pinecone({ apiKey: config.pineconeApiKey });
    const index = pinecone.index({ name: config.pineconeIndex }).namespace(repoId);

    // Clear existing vectors for this repo (in case of re-connect)
    try {
      await index.deleteAll();
    } catch {
      // Namespace may not exist on first run — ignore
    }

    for (let i = 0; i < allVectors.length; i += PINECONE_BATCH) {
      await index.upsert({ records: allVectors.slice(i, i + PINECONE_BATCH) });
    }

    await prisma.repository.update({
      where: { id: repoId },
      data: { embeddingStatus: 'completed', embeddedAt: new Date(), embeddingError: null },
    });

    logger.info(
      `Embedding [${repo.fullName}]: DONE — ${allVectors.length} vectors stored in Pinecone namespace "${repoId}"`,
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Embedding [repoId=${repoId}]: FAILED — ${message}`);
    await prisma.repository.update({
      where: { id: repoId },
      data: { embeddingStatus: 'failed', embeddingError: message },
    });
  }
}

// --------------------------------------------------------------------------
// PR diff analysis — embed diff, query Pinecone, store relevant files
// --------------------------------------------------------------------------


export async function analyzePrDiff(prId: string): Promise<void> {
  const pr = await prisma.pullRequest.findUnique({
    where: { id: prId },
    select: { id: true, number: true, diff: true, repositoryId: true },
  });

  console.log("pr", pr);
  if (!pr?.diff) {
    logger.warn(`PR analysis [prId=${prId}]: no diff available, skipping`);
    return;
  }

  await prisma.pullRequest.update({
    where: { id: prId },
    data: { analysisStatus: 'processing', analysisError: null },
  });

  try {
    // 1. Clean and Truncate the diff
    const cleanedDiff = cleanDiff(pr.diff);
    const diffText = cleanedDiff.length > MAX_CONTENT_CHARS 
      ? cleanedDiff.slice(0, MAX_CONTENT_CHARS) 
      : cleanedDiff;

    // 2. Embed the cleaned logic
    const [diffVector] = await batchEmbed([diffText], config.googleAiApiKey);

    // 3. Query Pinecone
    const pinecone = new Pinecone({ apiKey: config.pineconeApiKey });
    const index = pinecone.index({ name: config.pineconeIndex }).namespace(pr.repositoryId);

    const queryResult = await index.query({
      vector: diffVector,
      topK: 10,
      includeMetadata: true,
    });

    // 4. Filter by a Similarity Threshold
    // Only keep files that actually match (e.g., score > 0.5) 
    // to avoid showing irrelevant "random" files.
    const SIMILARITY_THRESHOLD = 0.4; 

    const relevantFiles = queryResult.matches
      .filter((m) => m.score !== undefined && m.score > SIMILARITY_THRESHOLD)
      .map((m) => ({
        filePath: m.metadata?.filePath ?? m.id,
        score: m.score,
      }));

    // 5. Final Update
    await prisma.pullRequest.update({
      where: { id: prId },
      data: { 
        analysisStatus: 'completed', 
        relevantFiles: relevantFiles // Prisma handles the JSON structure
      },
    });

    logger.info(
      `PR analysis [PR #${pr.number}]: completed — ${relevantFiles.length} files met threshold`,
    );

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`PR analysis [prId=${prId}]: FAILED — ${message}`);
    
    await prisma.pullRequest.update({
      where: { id: prId },
      data: { analysisStatus: 'failed', analysisError: message },
    });
  }
}
