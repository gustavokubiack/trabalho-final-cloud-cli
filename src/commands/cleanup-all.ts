import { text, isCancel, cancel, log, spinner, confirm } from "@clack/prompts";
import {
  TerminateInstancesCommand,
  DeleteSecurityGroupCommand,
  DeleteSubnetCommand,
  DeleteInternetGatewayCommand,
  DetachInternetGatewayCommand,
  DeleteRouteTableCommand,
  DeleteVpcCommand,
  DescribeInstancesCommand,
  DescribeSecurityGroupsCommand,
  DescribeSubnetsCommand,
  DescribeInternetGatewaysCommand,
  DescribeRouteTablesCommand,
  DescribeVpcsCommand,
  DescribeNetworkInterfacesCommand,
  waitUntilInstanceTerminated,
} from "@aws-sdk/client-ec2";
import {
  DeleteDBInstanceCommand,
  DeleteDBSubnetGroupCommand,
  DescribeDBInstancesCommand,
  DescribeDBSubnetGroupsCommand,
  waitUntilDBInstanceDeleted,
} from "@aws-sdk/client-rds";
import {
  DeleteLoadBalancerCommand,
  DeleteTargetGroupCommand,
  DeleteListenerCommand,
  DescribeLoadBalancersCommand,
  DescribeTargetGroupsCommand,
  DescribeListenersCommand,
} from "@aws-sdk/client-elastic-load-balancing-v2";
import { createEc2Client, createRdsClient, createElbClient } from "../lib/aws.js";
import type { AwsCredentials } from "../types/index.js";

function cancelAndExit(): never {
  cancel("Operação cancelada");
  process.exit(0);
}

async function retry<T>(fn: () => Promise<T>, label: string, maxRetries = 6, delayMs = 10000): Promise<T | null> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i < maxRetries - 1) {
        log.warn(`${label} — tentativa ${i + 1}/${maxRetries}, aguardando...`);
        await new Promise((r) => setTimeout(r, delayMs));
      } else {
        log.warn(`${label} — falhou após ${maxRetries} tentativas: ${(err as Error).message}`);
        return null;
      }
    }
  }
  return null;
}

export async function cleanupAll(creds: AwsCredentials) {
  const appName = await text({
    message: "Nome do projeto/app para limpar",
    validate: (v) => (v ? undefined : "Campo obrigatório"),
  });
  if (isCancel(appName)) return cancelAndExit();

  const confirmed = await confirm({
    message: `Isso vai deletar toda a infraestrutura de "${appName}". Continuar?`,
    initialValue: false,
  });
  if (isCancel(confirmed) || !confirmed) {
    cancel("Operação cancelada");
    return;
  }

  const ec2Client = createEc2Client(creds);
  const rdsClient = createRdsClient(creds);
  const elbClient = createElbClient(creds);

  const lbSpin = spinner();
  lbSpin.start("Deletando Load Balancer...");
  try {
    const lbs = await elbClient.send(new DescribeLoadBalancersCommand({ Names: [`${appName}-alb`] }));
    for (const lb of lbs.LoadBalancers ?? []) {
      const listeners = await elbClient.send(new DescribeListenersCommand({ LoadBalancerArn: lb.LoadBalancerArn }));
      for (const listener of listeners.Listeners ?? []) {
        await elbClient.send(new DeleteListenerCommand({ ListenerArn: listener.ListenerArn }));
      }
      await elbClient.send(new DeleteLoadBalancerCommand({ LoadBalancerArn: lb.LoadBalancerArn }));
    }
    lbSpin.stop("Load Balancer deletado");
  } catch (err) {
    lbSpin.stop("Aviso ao deletar Load Balancer");
    log.warn(`  ${(err as Error).message}`);
  }

  try {
    const tgs = await elbClient.send(new DescribeTargetGroupsCommand({ Names: [`${appName}-tg`] }));
    for (const tg of tgs.TargetGroups ?? []) {
      await elbClient.send(new DeleteTargetGroupCommand({ TargetGroupArn: tg.TargetGroupArn }));
    }
    log.success("Target Group deletado");
  } catch (err) {
    log.warn(`Aviso Target Group: ${(err as Error).message}`);
  }

  const ec2Spin = spinner();
  ec2Spin.start("Terminando instâncias EC2...");
  try {
    const instances = await ec2Client.send(new DescribeInstancesCommand({
      Filters: [
        { Name: "tag:Name", Values: [`${appName}-*`] },
        { Name: "instance-state-name", Values: ["pending", "running", "stopped"] },
      ],
    }));
    const ids = (instances.Reservations ?? [])
      .flatMap((r) => r.Instances ?? [])
      .map((i) => i.InstanceId!)
      .filter(Boolean);
    if (ids.length > 0) {
      await ec2Client.send(new TerminateInstancesCommand({ InstanceIds: ids }));
      for (const id of ids) {
        await waitUntilInstanceTerminated(
          { client: ec2Client, maxWaitTime: 900 },
          { InstanceIds: [id] }
        );
      }
    }
    ec2Spin.stop(`Instâncias EC2 terminadas: ${ids.join(", ") || "nenhuma"}`);
  } catch (err) {
    ec2Spin.stop("Aviso ao terminar EC2");
    log.warn(`  ${(err as Error).message}`);
  }

  const rdsSpin = spinner();
  rdsSpin.start("Deletando RDS...");
  try {
    const dbs = await rdsClient.send(new DescribeDBInstancesCommand({
      Filters: [{ Name: "db-instance-id", Values: [`${appName}-db`] }],
    }));
    for (const db of dbs.DBInstances ?? []) {
      if (db.DBInstanceIdentifier) {
        await rdsClient.send(new DeleteDBInstanceCommand({
          DBInstanceIdentifier: db.DBInstanceIdentifier,
          SkipFinalSnapshot: true,
        }));
        await waitUntilDBInstanceDeleted(
          { client: rdsClient, maxWaitTime: 600 },
          { DBInstanceIdentifier: db.DBInstanceIdentifier }
        );
      }
    }
    rdsSpin.stop("RDS deletado");
  } catch (err) {
    rdsSpin.stop("Aviso ao deletar RDS");
    log.warn(`  ${(err as Error).message}`);
  }

  try {
    const subGroups = await rdsClient.send(new DescribeDBSubnetGroupsCommand({
      Filters: [{ Name: "subnet-group-name", Values: [`${appName}-subnet-group`] }],
    }));
    for (const sg of subGroups.DBSubnetGroups ?? []) {
      if (sg.DBSubnetGroupName) {
        await rdsClient.send(new DeleteDBSubnetGroupCommand({ DBSubnetGroupName: sg.DBSubnetGroupName }));
      }
    }
    log.success("DB subnet group deletado");
  } catch (err) {
    log.warn(`Aviso DB subnet group: ${(err as Error).message}`);
  }

  const eniSpin = spinner();
  eniSpin.start("Aguardando liberação de interfaces de rede...");

  try {
    const vpcs = await ec2Client.send(new DescribeVpcsCommand({
      Filters: [{ Name: "tag:Name", Values: [`${appName}-vpc`] }],
    }));
    for (const vpc of vpcs.Vpcs ?? []) {
      await retry(async () => {
        const enis = await ec2Client.send(new DescribeNetworkInterfacesCommand({
          Filters: [{ Name: "vpc-id", Values: [vpc.VpcId!] }],
        }));
        if ((enis.NetworkInterfaces ?? []).length > 0) {
          throw new Error(`${enis.NetworkInterfaces!.length} ENI(s) ainda existem`);
        }
      }, `ENIs em ${vpc.VpcId}`, 18, 10000);
    }
    eniSpin.stop("Interfaces liberadas");
  } catch (err) {
    eniSpin.stop("Aviso ao aguardar ENIs");
    log.warn(`  ${(err as Error).message}`);
  }

  const sgSpin = spinner();
  sgSpin.start("Deletando Security Groups...");
  const sgNames = [`${appName}-alb-sg`, `${appName}-ec2-sg`, `${appName}-rds-sg`];
  for (const sgName of sgNames) {
    try {
      const sgs = await ec2Client.send(new DescribeSecurityGroupsCommand({
        Filters: [{ Name: "group-name", Values: [sgName] }],
      }));
      for (const sg of sgs.SecurityGroups ?? []) {
        if (sg.GroupId) {
          await ec2Client.send(new DeleteSecurityGroupCommand({ GroupId: sg.GroupId }));
        }
      }
    } catch {
    }
  }
  sgSpin.stop("Security Groups deletados");

  const vpcSpin = spinner();
  vpcSpin.start("Deletando VPC e recursos de rede...");

  try {
    const vpcs = await ec2Client.send(new DescribeVpcsCommand({
      Filters: [{ Name: "tag:Name", Values: [`${appName}-vpc`] }],
    }));

    for (const vpc of vpcs.Vpcs ?? []) {
      const vpcId = vpc.VpcId!;

      for (const subnetId of (await ec2Client.send(new DescribeSubnetsCommand({
        Filters: [{ Name: "vpc-id", Values: [vpcId] }],
      }))).Subnets?.map((s) => s.SubnetId!) ?? []) {
        await retry(
          () => ec2Client.send(new DeleteSubnetCommand({ SubnetId: subnetId })),
          `Subnet ${subnetId}`,
          6,
          10000
        );
      }

      const rts = await ec2Client.send(new DescribeRouteTablesCommand({
        Filters: [{ Name: "vpc-id", Values: [vpcId] }],
      }));
      for (const rt of rts.RouteTables ?? []) {
        if (!rt.Associations?.some((a) => a.Main) && rt.RouteTableId) {
          try {
            await ec2Client.send(new DeleteRouteTableCommand({ RouteTableId: rt.RouteTableId }));
          } catch {
          }
        }
      }

      const igws = await ec2Client.send(new DescribeInternetGatewaysCommand({
        Filters: [{ Name: "attachment.vpc-id", Values: [vpcId] }],
      }));
      for (const igw of igws.InternetGateways ?? []) {
          try {
            await ec2Client.send(new DetachInternetGatewayCommand({ InternetGatewayId: igw.InternetGatewayId, VpcId: vpcId }));
            await ec2Client.send(new DeleteInternetGatewayCommand({ InternetGatewayId: igw.InternetGatewayId }));
          } catch {
          }
      }

      await retry(
        () => ec2Client.send(new DeleteVpcCommand({ VpcId: vpcId })),
        `VPC ${vpcId}`,
        6,
        10000
      );
    }
    vpcSpin.stop("VPC deletada");
  } catch (err) {
    vpcSpin.stop("Aviso ao deletar VPC");
    log.warn(`  ${(err as Error).message}`);
  }

  log.success("Limpeza concluída");
}
