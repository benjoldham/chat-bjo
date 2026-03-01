import { defineBackend } from '@aws-amplify/backend';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { auth } from './auth/resource';
import { data } from './data/resource';
import { storage } from './storage/resource';
import { chatFunction } from './functions/chat/resource';
import { attachmentsFunction } from './functions/attachments/resource';

export const backend = defineBackend({
  auth,
  data,
  storage,
  chatFunction,
  attachmentsFunction,
});

backend.chatFunction.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
    resources: ['*'],
  })
);

// Needed for Marketplace-backed Bedrock models (e.g. Claude Sonnet 4.6)
backend.chatFunction.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions: ['aws-marketplace:ViewSubscriptions', 'aws-marketplace:Subscribe'],
    resources: ['*'],
  })
);

backend.chatFunction.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions: ['s3:PutObject', 's3:AbortMultipartUpload'],
    resources: [
      `${backend.storage.resources.bucket.bucketArn}/generated/*`,
      `${backend.storage.resources.bucket.bucketArn}/generated/nova-canvas/*`,
    ],
  })
);

backend.attachmentsFunction.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions: ['s3:PutObject', 's3:GetObject', 's3:DeleteObject', 's3:AbortMultipartUpload'],
    resources: [`${backend.storage.resources.bucket.bucketArn}/*`],
  })
);

backend.chatFunction.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions: ['s3:GetObject'],
    resources: [`${backend.storage.resources.bucket.bucketArn}/*`],
  })
);

// Explicitly pass bucket name into lambdas (don’t rely on implicit env var names)
backend.attachmentsFunction.resources.lambda.addEnvironment(
  'UPLOADS_BUCKET_NAME',
  backend.storage.resources.bucket.bucketName
);

backend.chatFunction.resources.lambda.addEnvironment(
  'UPLOADS_BUCKET_NAME',
  backend.storage.resources.bucket.bucketName
);




