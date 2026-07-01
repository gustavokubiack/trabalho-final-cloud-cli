import { EC2Client } from "@aws-sdk/client-ec2";
import { RDSClient } from "@aws-sdk/client-rds";
import { ElasticLoadBalancingV2Client } from "@aws-sdk/client-elastic-load-balancing-v2";
import { S3Client } from "@aws-sdk/client-s3";
import { EC2InstanceConnectClient } from "@aws-sdk/client-ec2-instance-connect";
import type { AwsCredentials } from "../types/index.js";

export function createEc2Client(creds: AwsCredentials) {
  return new EC2Client({
    region: creds.region,
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
    },
  });
}

export function createRdsClient(creds: AwsCredentials) {
  return new RDSClient({
    region: creds.region,
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
    },
  });
}

export function createElbClient(creds: AwsCredentials) {
  return new ElasticLoadBalancingV2Client({
    region: creds.region,
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
    },
  });
}

export function createS3Client(creds: AwsCredentials) {
  return new S3Client({
    region: creds.region,
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
    },
  });
}

export function createEc2InstanceConnectClient(creds: AwsCredentials) {
  return new EC2InstanceConnectClient({
    region: creds.region,
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
    },
  });
}
