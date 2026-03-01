import { defineFunction } from '@aws-amplify/backend';

export const chatFunction = defineFunction({
  name: 'chat',
  entry: './handler.ts',
  timeoutSeconds: 60,
  environment: {
    DEFAULT_MODEL_KEY: 'claude_haiku',
    DEFAULT_MAX_OUTPUT_TOKENS: '2500',

    // Nova Canvas lives in a different region than this Amplify backend (eu-west-2).
    // We call Bedrock Runtime in that region explicitly from the handler.
    BEDROCK_CANVAS_REGION: 'eu-west-1',
  },
  permissions: [
    {
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: ['*'],
    },
    {
      actions: ['aws-marketplace:ViewSubscriptions', 'aws-marketplace:Subscribe'],
      resources: ['*'],
    },

    // Allow saving Nova Canvas generated images back to S3
    // (scoped to objects under generated/ to avoid touching user uploads)
    {
      actions: ['s3:PutObject', 's3:AbortMultipartUpload'],
      resources: ['arn:aws:s3:::*/generated/*'],
    },
  ],
});
