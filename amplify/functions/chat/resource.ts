import { defineFunction } from '@aws-amplify/backend';

export const chatFunction = defineFunction({
  name: 'chat',
  entry: './handler.ts',
  timeoutSeconds: 60,
  environment: {
    DEFAULT_MODEL_KEY: 'claude_haiku',
  },
  permissions: [
    {
      actions: ['bedrock:InvokeModel'],
      resources: ['*'],
    },
  ],
});
