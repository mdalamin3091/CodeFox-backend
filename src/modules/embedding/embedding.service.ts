import { Pinecone } from '@pinecone-database/pinecone';
import { Octokit } from '@octokit/rest';
import prisma from '../../config/prisma.js';
import config from '../../config/index.js';
import logger from '../../utils/logger.js';
import {GoogleGenAI} from '@google/genai';

// --------------------------------------------------------------------------
// File inclusion whitelist — only these are worth embedding
// --------------------------------------------------------------------------

// Extensions that contain meaningful source/config content
const ALLOWED_EXTENSIONS = new Set([
  // Web
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.html', '.htm', '.css', '.scss', '.sass', '.less',
  '.vue', '.svelte', '.astro',
  // Backend / systems
  '.py', '.pyx', '.pyi',
  '.go',
  '.rs',
  '.java', '.kt', '.kts',
  '.cs', '.fs', '.fsi', '.fsx',
  '.cpp', '.cc', '.cxx', '.c', '.h', '.hpp',
  '.rb',
  '.php',
  '.swift',
  '.scala',
  '.dart',
  '.ex', '.exs',
  '.erl', '.hrl',
  '.hs', '.lhs',
  '.ml', '.mli',
  '.clj', '.cljs',
  '.lua',
  '.r',
  // Shell / scripting
  '.sh', '.bash', '.zsh', '.fish',
  '.ps1', '.psm1',
  '.pl', '.pm',
  // Config / data / markup
  '.json', '.jsonc',
  '.yaml', '.yml',
  '.toml',
  '.xml',
  '.graphql', '.gql',
  '.proto',
  '.sql',
  '.tf', '.tfvars',
  // Docs (useful for context)
  '.md', '.mdx',
]);

// Extension-less filenames that are worth embedding
const ALLOWED_BARE_FILENAMES = new Set([
  'Makefile', 'Dockerfile', 'Jenkinsfile', 'Procfile',
  'Rakefile', 'Gemfile', 'Vagrantfile', 'Brewfile',
  '.editorconfig',
  '.prettierrc', '.eslintrc', '.stylelintrc'
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

async function batchEmbed(texts: string[], apiKey: string, retries = 4): Promise<number[][]> {
  const genAI = new GoogleGenAI({ apiKey });
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const result = await genAI.models.embedContent({
        model: 'gemini-embedding-001',
        contents: texts,
      });
      if (!result.embeddings) throw new Error('No embeddings returned from Gemini');
      return result.embeddings.map((e) => e.values ?? []);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const is429 = msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED');
      if (is429 && attempt < retries) {
        const delay = Math.min(2 ** attempt * 5_000, 60_000); // 5s, 10s, 20s, 40s
        logger.warn(`Embedding rate limited (attempt ${attempt + 1}/${retries + 1}), retrying in ${delay / 1000}s…`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw new Error('batchEmbed: exhausted retries');
}

const MAX_FILE_BYTES = 150_000;    // skip files > 150 KB
const MAX_CONTENT_CHARS = 10_000; // truncate content at ~2500 tokens
const EMBED_BATCH = 20;           // embedMany batch size (smaller = fewer rate-limit hits)
const PINECONE_BATCH = 100;       // Pinecone upsert batch size
const FETCH_CONCURRENCY = 8;      // parallel blob fetches

function shouldInclude(filePath: string, sizeBytes?: number): boolean {
  // Hard size cap regardless of type
  if (sizeBytes !== undefined && sizeBytes > MAX_FILE_BYTES) return false;

  const parts = filePath.split('/');
  const filename = parts[parts.length - 1];
  const lower = filename.toLowerCase();

  // Bare filenames with no extension (Makefile, Dockerfile, etc.)
  if (ALLOWED_BARE_FILENAMES.has(filename)) return true;

  // Match by extension (longest suffix first handles .min.js, .d.ts, etc.)
  for (const ext of ALLOWED_EXTENSIONS) {
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
// Delete all vectors for a repository namespace (used on disconnect)
// --------------------------------------------------------------------------

export async function deleteRepositoryEmbedding(repoId: string): Promise<void> {
  try {
    const pc = new Pinecone({ apiKey: config.pineconeApiKey });
    const index = pc.index({ name: config.pineconeIndex });
    await index.namespace(repoId).deleteAll();
    logger.info(`[embedding] Deleted Pinecone namespace for repo ${repoId}`);
  } catch (err) {
    // Cleanup failure must not block the disconnect flow
    logger.warn(`[embedding] Failed to delete Pinecone namespace for repo ${repoId}`, { err });
  }
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
        shouldInclude(item.path, item.size),
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
