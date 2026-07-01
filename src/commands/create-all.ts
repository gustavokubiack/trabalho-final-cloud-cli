import { text, select, password, isCancel, cancel, log, spinner } from "@clack/prompts";
import {
  RunInstancesCommand,
  CreateSecurityGroupCommand,
  AuthorizeSecurityGroupIngressCommand,
  CreateVpcCommand,
  CreateSubnetCommand,
  CreateInternetGatewayCommand,
  AttachInternetGatewayCommand,
  CreateRouteTableCommand,
  CreateRouteCommand,
  AssociateRouteTableCommand,
  ModifyVpcAttributeCommand,
  ModifySubnetAttributeCommand,
  DescribeAvailabilityZonesCommand,
  DescribeInternetGatewaysCommand,
  DescribeSecurityGroupsCommand,
  DescribeVpcsCommand,
  DescribeSubnetsCommand,
  waitUntilInstanceRunning,
  type _InstanceType,
} from "@aws-sdk/client-ec2";
import {
  CreateDBInstanceCommand,
  CreateDBSubnetGroupCommand,
  DescribeDBInstancesCommand,
  waitUntilDBInstanceAvailable,
} from "@aws-sdk/client-rds";
import {
  CreateLoadBalancerCommand,
  CreateTargetGroupCommand,
  CreateListenerCommand,
  RegisterTargetsCommand,
  DescribeLoadBalancersCommand,
  waitUntilLoadBalancerAvailable,
} from "@aws-sdk/client-elastic-load-balancing-v2";
import { createEc2Client, createRdsClient, createElbClient } from "../lib/aws.js";
import type { AwsCredentials } from "../types/index.js";

function cancelAndExit(): never {
  cancel("Operação cancelada");
  process.exit(0);
}

interface AllParams {
  appName: string;
  vpcId: string;
  subnetIds: string[];
  ami: string;
  instanceType: string;
  dbEngine: string;
  dbInstanceClass: string;
  dbUsername: string;
  dbPassword: string;
  dbStorage: number;
}

async function findSecurityGroupByName(ec2Client: ReturnType<typeof createEc2Client>, name: string, vpcId: string): Promise<string | null> {
  try {
    const result = await ec2Client.send(new DescribeSecurityGroupsCommand({
      Filters: [
        { Name: "group-name", Values: [name] },
        { Name: "vpc-id", Values: [vpcId] },
      ],
    }));
    return result.SecurityGroups?.[0]?.GroupId ?? null;
  } catch {
    return null;
  }
}

function generateUserData(params: AllParams, dbHost: string): string {
  const dbPort = params.dbEngine === "postgres" ? "5432" : "3306";

  return `#!/bin/bash
set -x
exec &> >(tee /tmp/user-data.log)

apt-get update -qq
apt-get install -y -qq python3 python3-pip python3-venv git

mkdir -p /home/ubuntu
cd /home/ubuntu
git clone https://github.com/gustavokubiack/to-do-fastapi app
cd app

python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

chown -R ubuntu:ubuntu /home/ubuntu/app

cat > /etc/systemd/system/web-app.service << 'ENDSVC'
[Unit]
Description=FastAPI To-Do Application
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/app
ExecStart=/home/ubuntu/app/venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 3000
Environment=DB_HOST=${dbHost}
Environment=DB_PORT=${dbPort}
Environment=DB_USER=${params.dbUsername}
Environment=DB_PASSWORD=${params.dbPassword}
Environment=DB_NAME=appdb
Environment=DB_ENGINE=${params.dbEngine}
Environment=APP_NAME=${params.appName}
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
ENDSVC

systemctl daemon-reload
systemctl enable web-app
systemctl start web-app
`;
}

export async function createAll(creds: AwsCredentials) {
  log.info("Vamos criar toda a infraestrutura: VPC + EC2 + RDS + Load Balancer");

  const appName = await text({
    message: "Nome do projeto/aplicação",
    initialValue: "app-cloud",
    validate: (v) => (v ? undefined : "Campo obrigatório"),
  });
  if (isCancel(appName)) return cancelAndExit();

  const ami = await text({
    message: "AMI ID (Ubuntu 24.04 LTS)",
    initialValue: "ami-0e86e20dae9224db8",
    validate: (v) => (v ? undefined : "Campo obrigatório"),
  });
  if (isCancel(ami)) return cancelAndExit();

  const instanceType = (await select({
    message: "Tipo de instância EC2",
    options: [
      { value: "t2.micro", label: "t2.micro", hint: "Free tier" },
      { value: "t2.small", label: "t2.small" },
      { value: "t2.medium", label: "t2.medium" },
      { value: "t3.micro", label: "t3.micro" },
      { value: "t3.small", label: "t3.small" },
    ],
  })) as string;
  if (isCancel(instanceType)) return cancelAndExit();

  const dbEngine = "postgres";

  const dbInstanceClass = (await select({
    message: "Classe da instância RDS",
    options: [
      { value: "db.t3.micro", label: "db.t3.micro", hint: "Free tier" },
      { value: "db.t3.small", label: "db.t3.small" },
      { value: "db.t3.medium", label: "db.t3.medium" },
    ],
  })) as string;
  if (isCancel(dbInstanceClass)) return cancelAndExit();

  const dbUsername = await text({
    message: "Usuário mestre do banco",
    validate: (v) => (v ? undefined : "Campo obrigatório"),
  });
  if (isCancel(dbUsername)) return cancelAndExit();

  const dbPassword = await password({
    message: "Senha do banco (mín. 8 caracteres)",
    validate: (v) => v && v.length >= 8 ? undefined : "Mínimo de 8 caracteres",
  });
  if (isCancel(dbPassword)) return cancelAndExit();

  const dbStorageStr = await text({
    message: "Armazenamento RDS (GB)",
    initialValue: "20",
    validate: (v) => !isNaN(Number(v)) && Number(v) >= 20 ? undefined : "Mínimo de 20 GB",
  });
  if (isCancel(dbStorageStr)) return cancelAndExit();

  const ec2Client = createEc2Client(creds);
  const rdsClient = createRdsClient(creds);
  const elbClient = createElbClient(creds);

  const vpcSpin = spinner();
  vpcSpin.start("Verificando VPC padrão...");

  let vpcId: string, subnetIds: string[];

  try {
    const vpcs = await ec2Client.send(new DescribeVpcsCommand({
      Filters: [{ Name: "is-default", Values: ["true"] }],
    }));
    const defaultVpc = vpcs.Vpcs?.[0];
    if (defaultVpc?.VpcId) {
      vpcId = defaultVpc.VpcId;
      vpcSpin.stop(`Usando VPC padrão: ${vpcId}`);

      const subnetsResult = await ec2Client.send(new DescribeSubnetsCommand({
        Filters: [{ Name: "vpc-id", Values: [vpcId] }],
      }));
      const allSubnets = subnetsResult.Subnets ?? [];
      subnetIds = allSubnets
        .filter((s) => s.MapPublicIpOnLaunch)
        .map((s) => s.SubnetId!)
        .slice(0, 2);
      if (subnetIds.length < 2) {
        subnetIds = allSubnets
          .map((s) => s.SubnetId!)
          .slice(0, 2);
      }
      if (subnetIds.length < 2) {
        log.warn("VPC padrão não tem subnets suficientes, criando...");
        throw new Error("Not enough subnets");
      }
      log.info(`Usando subnets: ${subnetIds.join(", ")}`);
    } else {
      throw new Error("No default VPC");
    }
  } catch {
    vpcSpin.start("Criando VPC...");
    try {
      const vpc = await ec2Client.send(new CreateVpcCommand({
        CidrBlock: "10.0.0.0/16",
        TagSpecifications: [
          { ResourceType: "vpc", Tags: [{ Key: "Name", Value: `${appName}-vpc` }] },
        ],
      }));
      vpcId = vpc.Vpc?.VpcId ?? "";
      if (!vpcId) throw new Error("Falha ao criar VPC");
      vpcSpin.stop(`VPC criada: ${vpcId}`);

      await ec2Client.send(new ModifyVpcAttributeCommand({
        VpcId: vpcId,
        EnableDnsHostnames: { Value: true },
      }));

      const igwSpin = spinner();
      igwSpin.start("Criando Internet Gateway...");
      try {
        const igw = await ec2Client.send(new CreateInternetGatewayCommand({
          TagSpecifications: [
            { ResourceType: "internet-gateway", Tags: [{ Key: "Name", Value: `${appName}-igw` }] },
          ],
        }));
        const igwId = igw.InternetGateway?.InternetGatewayId ?? "";
        await ec2Client.send(new AttachInternetGatewayCommand({ InternetGatewayId: igwId, VpcId: vpcId }));
        igwSpin.stop("Internet Gateway criado e anexado");
      } catch (err) {
        igwSpin.stop("Erro ao criar Internet Gateway");
        log.error(`Erro: ${(err as Error).message}`);
        return;
      }

      const subnetSpin = spinner();
      subnetSpin.start("Criando subnets...");
      try {
        const azResult = await ec2Client.send(new DescribeAvailabilityZonesCommand({}));
        const azs = azResult.AvailabilityZones ?? [];
        const azNames = azs.filter((az) => az.ZoneType === "availability-zone").map((az) => az.ZoneName!);
        const az1 = azNames[0];
        const az2 = azNames.length > 1 ? azNames[1] : azNames[0];

        const subnet1 = await ec2Client.send(new CreateSubnetCommand({
          VpcId: vpcId, CidrBlock: "10.0.1.0/24", AvailabilityZone: az1,
          TagSpecifications: [{ ResourceType: "subnet", Tags: [{ Key: "Name", Value: `${appName}-subnet-1` }] }],
        }));
        const subnet2 = await ec2Client.send(new CreateSubnetCommand({
          VpcId: vpcId, CidrBlock: "10.0.2.0/24", AvailabilityZone: az2,
          TagSpecifications: [{ ResourceType: "subnet", Tags: [{ Key: "Name", Value: `${appName}-subnet-2` }] }],
        }));

        subnetIds = [subnet1.Subnet?.SubnetId ?? "", subnet2.Subnet?.SubnetId ?? ""].filter(Boolean);
        for (const sid of subnetIds) {
          await ec2Client.send(new ModifySubnetAttributeCommand({
            SubnetId: sid, MapPublicIpOnLaunch: { Value: true },
          }));
        }
        if (subnetIds.length < 2) throw new Error("Falha ao criar subnets");
        subnetSpin.stop(`Subnets criadas: ${subnetIds.join(", ")}`);
      } catch (err) {
        subnetSpin.stop("Erro ao criar subnets");
        log.error(`Erro: ${(err as Error).message}`);
        return;
      }

      const routeSpin = spinner();
      routeSpin.start("Configurando tabela de roteamento...");
      try {
        const rt = await ec2Client.send(new CreateRouteTableCommand({
          VpcId: vpcId,
          TagSpecifications: [{ ResourceType: "route-table", Tags: [{ Key: "Name", Value: `${appName}-rt` }] }],
        }));
        const rtId = rt.RouteTable?.RouteTableId ?? "";
        const igwResult = await ec2Client.send(new DescribeInternetGatewaysCommand({
          Filters: [{ Name: "attachment.vpc-id", Values: [vpcId] }],
        }));
        const igwId = igwResult.InternetGateways?.[0]?.InternetGatewayId ?? "";
        await ec2Client.send(new CreateRouteCommand({
          RouteTableId: rtId, DestinationCidrBlock: "0.0.0.0/0", GatewayId: igwId,
        }));
        for (const subnetId of subnetIds) {
          await ec2Client.send(new AssociateRouteTableCommand({ RouteTableId: rtId, SubnetId: subnetId }));
        }
        routeSpin.stop("Roteamento configurado");
      } catch (err) {
        routeSpin.stop("Erro ao configurar roteamento");
        log.error(`Erro: ${(err as Error).message}`);
        return;
      }
    } catch (err2) {
      vpcSpin.stop("Erro ao configurar VPC");
      log.error(`Erro: ${(err2 as Error).message}`);
      log.error("Verifique se há uma VPC padrão ou se tem permissão para criar VPCs.");
      return;
    }
  }

  const params: AllParams = {
    appName: appName as string,
    vpcId,
    subnetIds,
    ami: ami as string,
    instanceType,
    dbEngine,
    dbInstanceClass,
    dbUsername: dbUsername as string,
    dbPassword: dbPassword as string,
    dbStorage: Number(dbStorageStr),
  };

  const sgSpin = spinner();
  sgSpin.start("Criando security groups...");

  let albSgId: string, ec2SgId: string, rdsSgId: string;

  async function findOrCreateSg(name: string, desc: string): Promise<string> {
    const existing = await findSecurityGroupByName(ec2Client, name, params.vpcId);
    if (existing) return existing;
    const result = await ec2Client.send(new CreateSecurityGroupCommand({
      GroupName: name, Description: desc, VpcId: params.vpcId,
    }));
    return result.GroupId!;
  }

  async function authorizeSgRule(groupId: string, permission: {
    IpProtocol: string; FromPort: number; ToPort: number;
    IpRanges?: { CidrIp: string }[];
    UserIdGroupPairs?: { GroupId: string }[];
  }): Promise<void> {
    try {
      await ec2Client.send(new AuthorizeSecurityGroupIngressCommand({
        GroupId: groupId, IpPermissions: [permission],
      }));
    } catch (err) {
      if ((err as Error).name === "InvalidPermission.Duplicate") return;
      throw err;
    }
  }

  try {
    albSgId = await findOrCreateSg(`${params.appName}-alb-sg`, "ALB security group");
    ec2SgId = await findOrCreateSg(`${params.appName}-ec2-sg`, "EC2 security group");
    rdsSgId = await findOrCreateSg(`${params.appName}-rds-sg`, "RDS security group");

    await authorizeSgRule(albSgId, {
      IpProtocol: "tcp", FromPort: 80, ToPort: 80,
      IpRanges: [{ CidrIp: "0.0.0.0/0" }],
    });

    await authorizeSgRule(ec2SgId, {
      IpProtocol: "tcp", FromPort: 3000, ToPort: 3000,
      UserIdGroupPairs: [{ GroupId: albSgId }],
    });

    const dbPortNum = params.dbEngine === "postgres" ? 5432 : 3306;
    await authorizeSgRule(rdsSgId, {
      IpProtocol: "tcp", FromPort: dbPortNum, ToPort: dbPortNum,
      UserIdGroupPairs: [{ GroupId: ec2SgId }],
    });

    sgSpin.stop("Security groups prontos");
  } catch (err) {
    sgSpin.stop("Erro ao criar security groups");
    log.error(`Erro: ${(err as Error).message}`);
    return;
  }

  const dbSgSpin = spinner();
  dbSgSpin.start("Criando DB subnet group...");

  try {
    await rdsClient.send(new CreateDBSubnetGroupCommand({
      DBSubnetGroupName: `${params.appName}-subnet-group`,
      DBSubnetGroupDescription: `Subnet group for ${params.appName}`,
      SubnetIds: params.subnetIds,
    }));
    dbSgSpin.stop("DB subnet group criado");
  } catch (err) {
    const exists = (err as Error).name === "DBSubnetGroupAlreadyExistsFault"
      || (err as Error).message?.includes("already exists");
    if (exists) {
      dbSgSpin.stop("DB subnet group já existe, reutilizando");
    } else {
      dbSgSpin.stop("Erro ao criar DB subnet group");
      log.error(`Erro: ${(err as Error).message}`);
      return;
    }
  }

  const rdsSpin = spinner();
  rdsSpin.start("Criando instância RDS...");

  let dbHost = "";
  const dbInstanceId = `${params.appName}-db`;

  try {
    await rdsClient.send(new CreateDBInstanceCommand({
      DBInstanceIdentifier: dbInstanceId,
      Engine: params.dbEngine,
      DBInstanceClass: params.dbInstanceClass,
      MasterUsername: params.dbUsername,
      MasterUserPassword: params.dbPassword,
      AllocatedStorage: params.dbStorage,
      DBName: "appdb",
      DBSubnetGroupName: `${params.appName}-subnet-group`,
      VpcSecurityGroupIds: [rdsSgId],
      PubliclyAccessible: false,
    }));
    rdsSpin.stop("Instância RDS sendo provisionada");
  } catch (err) {
    rdsSpin.stop("Erro ao criar RDS");
    log.error(`Erro: ${(err as Error).message}`);
    return;
  }

  const waitSpin = spinner();
  waitSpin.start("Aguardando RDS ficar disponível (pode levar alguns minutos)...");

  try {
    await waitUntilDBInstanceAvailable(
      { client: rdsClient, maxWaitTime: 900 },
      { DBInstanceIdentifier: dbInstanceId }
    );
    waitSpin.stop("RDS disponível");
  } catch (err) {
    waitSpin.stop("Timeout ao aguardar RDS");
    log.error(`RDS não ficou disponível: ${(err as Error).message}`);
    return;
  }

  try {
    const { DBInstances } = await rdsClient.send(new DescribeDBInstancesCommand({
      DBInstanceIdentifier: dbInstanceId,
    }));
    dbHost = DBInstances?.[0]?.Endpoint?.Address ?? "";
    if (!dbHost) throw new Error("Endpoint não encontrado");
    log.success(`RDS endpoint: ${dbHost}`);
  } catch (err) {
    log.error(`Erro ao obter endpoint RDS: ${(err as Error).message}`);
    return;
  }

  const ec2Spin = spinner();
  ec2Spin.start("Lançando 2 instâncias EC2...");

  const userData = Buffer.from(generateUserData(params, dbHost)).toString("base64");
  const instanceIds: string[] = [];

  for (const subnetId of params.subnetIds) {
    try {
      const ec2Result = await ec2Client.send(new RunInstancesCommand({
        ImageId: params.ami,
        InstanceType: params.instanceType as _InstanceType,
        MinCount: 1,
        MaxCount: 1,
        SecurityGroupIds: [ec2SgId],
        SubnetId: subnetId,
        UserData: userData,
        TagSpecifications: [
          { ResourceType: "instance", Tags: [{ Key: "Name", Value: `${params.appName}-${subnetId.slice(-8)}` }] },
        ],
      }));
      const id = ec2Result.Instances?.[0]?.InstanceId ?? "";
      if (id) instanceIds.push(id);
    } catch (err) {
      log.error(`Erro ao criar EC2 em ${subnetId}: ${(err as Error).message}`);
    }
  }

  if (instanceIds.length === 0) {
    ec2Spin.stop("Falha ao criar instâncias EC2");
    return;
  }
  ec2Spin.stop(`EC2 criadas: ${instanceIds.join(", ")}`);

  const waitEc2Spin = spinner();
  waitEc2Spin.start("Aguardando EC2s ficarem em execução...");
  try {
    await waitUntilInstanceRunning(
      { client: ec2Client, maxWaitTime: 900 },
      { InstanceIds: instanceIds }
    );
    waitEc2Spin.stop("EC2s em execução");
  } catch (err) {
    waitEc2Spin.stop("Timeout ao aguardar EC2s");
    log.warn(`EC2s podem não estar prontas: ${(err as Error).message}`);
  }

  const tgSpin = spinner();
  tgSpin.start("Criando Target Group...");

  let targetGroupArn: string;

  try {
    const tgResult = await elbClient.send(new CreateTargetGroupCommand({
      Name: `${params.appName}-tg`,
      Protocol: "HTTP",
      Port: 3000,
      VpcId: params.vpcId,
      TargetType: "instance",
      HealthCheckPath: "/health",
      HealthCheckPort: "3000",
      HealthCheckProtocol: "HTTP",
    }));
    targetGroupArn = tgResult.TargetGroups?.[0]?.TargetGroupArn ?? "";
    tgSpin.stop("Target Group criado");
  } catch (err) {
    tgSpin.stop("Erro ao criar Target Group");
    log.error(`Erro: ${(err as Error).message}`);
    return;
  }

  try {
    await elbClient.send(new RegisterTargetsCommand({
      TargetGroupArn: targetGroupArn,
      Targets: instanceIds.map(id => ({ Id: id, Port: 3000 })),
    }));
    log.success(`${instanceIds.length} instâncias registradas no Target Group`);
  } catch (err) {
    log.error(`Erro ao registrar targets: ${(err as Error).message}`);
  }

  const lbSpin = spinner();
  lbSpin.start("Criando Load Balancer...");

  let lbArn: string;

  try {
    const lbResult = await elbClient.send(new CreateLoadBalancerCommand({
      Name: `${params.appName}-alb`,
      Scheme: "internet-facing",
      Subnets: params.subnetIds,
      SecurityGroups: [albSgId],
    }));
    lbArn = lbResult.LoadBalancers?.[0]?.LoadBalancerArn ?? "";
    lbSpin.stop("Load Balancer criado");
  } catch (err) {
    lbSpin.stop("Erro ao criar Load Balancer");
    log.error(`Erro: ${(err as Error).message}`);
    return;
  }

  const waitLbSpin = spinner();
  waitLbSpin.start("Aguardando Load Balancer ficar disponível...");
  try {
    await waitUntilLoadBalancerAvailable(
      { client: elbClient, maxWaitTime: 900 },
      { LoadBalancerArns: [lbArn] }
    );
    waitLbSpin.stop("Load Balancer disponível");
  } catch (err) {
    waitLbSpin.stop("Timeout ao aguardar ALB");
    log.warn(`ALB pode não estar pronto: ${(err as Error).message}`);
  }

  try {
    await elbClient.send(new CreateListenerCommand({
      LoadBalancerArn: lbArn,
      Protocol: "HTTP",
      Port: 80,
      DefaultActions: [{ Type: "forward", TargetGroupArn: targetGroupArn }],
    }));
    log.success("Listener HTTP:80 criado");
  } catch (err) {
    log.error(`Erro ao criar listener: ${(err as Error).message}`);
  }

  const { LoadBalancers } = await elbClient.send(new DescribeLoadBalancersCommand({
    LoadBalancerArns: [lbArn],
  }));
  const lbDns = LoadBalancers?.[0]?.DNSName ?? "";

  log.success("=== INFRAESTRUTURA CRIADA COM SUCESSO ===");
  log.info(`VPC: ${params.vpcId}`);
  log.info(`Subnets: ${params.subnetIds.join(", ")}`);
  log.info(`EC2s: ${instanceIds.join(", ")}`);
  log.info(`RDS: ${dbHost}`);
  log.info(`ALB DNS: ${lbDns}`);
  log.info(`Acesse: http://${lbDns}`);
}
