import { defineFunction } from '@aws-amplify/backend';

export const chatFunction = defineFunction({
  name: 'chat',
  entry: './handler.ts',
  environment: {
    BEDROCK_MODEL_ID: 'anthropic.claude-3-haiku-20240307-v1:0',
  },
  permissions: [
    {
      actions: ['bedrock:InvokeModel'],
      resources: ['*'],
    },
  ],
});

