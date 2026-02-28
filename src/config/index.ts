import dotenv from 'dotenv';

dotenv.config();

const config = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000', 10),
  betterAuth: {
    secret: process.env.BETTER_AUTH_SECRET || 'fallback-secret-change-in-production',
    url: process.env.BETTER_AUTH_URL || 'http://localhost:3000',
  },
  github: {
    clientId: process.env.GITHUB_CLIENT_ID || '',
    clientSecret: process.env.GITHUB_CLIENT_SECRET || '',
  },
  webhookBaseUrl: process.env.WEBHOOK_BASE_URL || 'http://localhost:4000',
  googleAiApiKey: process.env.GOOGLE_AI_API_KEY || '',
  openRouterApiKey: process.env.OPEN_ROUTER_API_KEY || '',
  pineconeApiKey: process.env.PINECONE_API_KEY || '',
  pineconeIndex: process.env.PINECONE_INDEX || 'codefox',
};

export default config;
