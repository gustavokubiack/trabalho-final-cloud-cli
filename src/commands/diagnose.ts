import { text, isCancel, cancel, log } from "@clack/prompts";
import {
  DescribeInstancesCommand,
  DescribeSecurityGroupsCommand,
  GetConsoleOutputCommand,
} from "@aws-sdk/client-ec2";
import {
  DescribeDBInstancesCommand,
} from "@aws-sdk/client-rds";
import {
  DescribeTargetGroupsCommand,
  DescribeTargetHealthCommand,
  DescribeLoadBalancersCommand,
} from "@aws-sdk/client-elastic-load-balancing-v2";
import { createEc2Client, createRdsClient, createElbClient } from "../lib/aws.js";
import type { AwsCredentials } from "../types/index.js";

function cancelAndExit(): never {
  cancel("Operação cancelada");
  process.exit(0);
}

export async function diagnose(creds: AwsCredentials) {
  const appName = await text({
    message: "Nome do projeto/aplicação",
    validate: (v) => (v ? undefined : "Campo obrigatório"),
  });
  if (isCancel(appName)) return cancelAndExit();

  const ec2Client = createEc2Client(creds);
  const rdsClient = createRdsClient(creds);
  const elbClient = createElbClient(creds);

  log.info("=== DIAGNÓSTICO ===");

  try {
    const instances = await ec2Client.send(new DescribeInstancesCommand({
      Filters: [
        { Name: "tag:Name", Values: [`${appName}-*`] },
        { Name: "instance-state-name", Values: ["pending", "running", "stopped", "stopping"] },
      ],
    }));
    for (const res of instances.Reservations ?? []) {
      for (const inst of res.Instances ?? []) {
        log.info(`EC2 ${inst.InstanceId}: ${inst.State?.Name}`);
        if (inst.PublicIpAddress) log.info(`  IP público: ${inst.PublicIpAddress}`);
        if (inst.PrivateIpAddress) log.info(`  IP privado: ${inst.PrivateIpAddress}`);
      }
    }
  } catch (err) {
    log.warn(`Erro ao descrever EC2: ${(err as Error).message}`);
  }

  try {
    const dbs = await rdsClient.send(new DescribeDBInstancesCommand({
      Filters: [{ Name: "db-instance-id", Values: [`${appName}-db`] }],
    }));
    for (const db of dbs.DBInstances ?? []) {
      log.info(`RDS ${db.DBInstanceIdentifier}: ${db.DBInstanceStatus}`);
      log.info(`  Endpoint: ${db.Endpoint?.Address}:${db.Endpoint?.Port}`);
    }
  } catch (err) {
    log.warn(`Erro ao descrever RDS: ${(err as Error).message}`);
  }

  try {
    const tgs = await elbClient.send(new DescribeTargetGroupsCommand({
      Names: [`${appName}-tg`],
    }));
    for (const tg of tgs.TargetGroups ?? []) {
      log.info(`Target Group: ${tg.TargetGroupName}`);
      const health = await elbClient.send(new DescribeTargetHealthCommand({
        TargetGroupArn: tg.TargetGroupArn,
      }));
      for (const desc of health.TargetHealthDescriptions ?? []) {
        log.info(`  Target ${desc.Target?.Id}:${desc.Target?.Port}`);
        log.info(`    Health: ${desc.TargetHealth?.State} — ${desc.TargetHealth?.Description ?? ""}`);
      }
    }
  } catch (err) {
    log.warn(`Erro ao descrever target health: ${(err as Error).message}`);
  }

  try {
    const lbs = await elbClient.send(new DescribeLoadBalancersCommand({
      Names: [`${appName}-alb`],
    }));
    for (const lb of lbs.LoadBalancers ?? []) {
      log.info(`ALB ${lb.LoadBalancerName}: ${lb.State?.Code}`);
      log.info(`  DNS: ${lb.DNSName}`);
      log.info(`  Acesse: http://${lb.DNSName}`);
    }
  } catch (err) {
    log.warn(`Erro ao descrever ALB: ${(err as Error).message}`);
  }

  try {
    for (const name of [`${appName}-alb-sg`, `${appName}-ec2-sg`, `${appName}-rds-sg`]) {
      const sgs = await ec2Client.send(new DescribeSecurityGroupsCommand({
        Filters: [{ Name: "group-name", Values: [name] }],
      }));
      for (const sg of sgs.SecurityGroups ?? []) {
        log.info(`SG ${sg.GroupName} (${sg.GroupId})`);
        for (const rule of sg.IpPermissions ?? []) {
          for (const range of rule.IpRanges ?? []) {
            log.info(`  Inbound: ${rule.IpProtocol} ${rule.FromPort}-${rule.ToPort} from ${range.CidrIp}`);
          }
          for (const pair of rule.UserIdGroupPairs ?? []) {
            log.info(`  Inbound: ${rule.IpProtocol} ${rule.FromPort}-${rule.ToPort} from sg ${pair.GroupId}`);
          }
        }
      }
    }
  } catch (err) {
    log.warn(`Erro ao descrever SGs: ${(err as Error).message}`);
  }

  try {
    const instances = await ec2Client.send(new DescribeInstancesCommand({
      Filters: [
        { Name: "tag:Name", Values: [appName as string] },
        { Name: "instance-state-name", Values: ["running", "stopped"] },
      ],
    }));
    for (const res of instances.Reservations ?? []) {
      for (const inst of res.Instances ?? []) {
        const output = await ec2Client.send(new GetConsoleOutputCommand({
          InstanceId: inst.InstanceId,
        }));
        if (output.Output) {
          const decoded = Buffer.from(output.Output).toString("utf-8");
          const lines = decoded.split("\n");
          const lastLines = lines.slice(-200).join("\n");
          log.info(`Console output (últimas 200 linhas) para ${inst.InstanceId}:`);
          console.log(lastLines);
          const keywords = ["npm", "node", "App running", "Error", "error", "listen", "fail"];
          const relevant = lines.filter(l => keywords.some(k => l.toLowerCase().includes(k.toLowerCase())));
          if (relevant.length > 0) {
            log.info("Linhas relevantes (npm, App, Error, etc):");
            for (const line of relevant) {
              console.log(`  ${line}`);
            }
          }
        }
      }
    }
  } catch (err) {
    log.warn(`Erro ao obter console output: ${(err as Error).message}`);
  }

  log.info("=== FIM DO DIAGNÓSTICO ===");
}
