import { text, isCancel, cancel, log } from "@clack/prompts";
import {
  CreateKeyPairCommand,
  DescribeKeyPairsCommand,
  DescribeSecurityGroupsCommand,
  AuthorizeSecurityGroupIngressCommand,
  DescribeInstancesCommand,
} from "@aws-sdk/client-ec2";
import { SendSSHPublicKeyCommand } from "@aws-sdk/client-ec2-instance-connect";
import { createEc2Client } from "../lib/aws.js";
import { createEc2InstanceConnectClient } from "../lib/aws.js";
import type { AwsCredentials } from "../types/index.js";
import * as fs from "node:fs";
import { execSync } from "node:child_process";

function cancelAndExit(): never {
  cancel("Operação cancelada");
  process.exit(0);
}

export async function setupSsh(creds: AwsCredentials) {
  const appName = await text({
    message: "Nome do projeto/aplicação",
    validate: (v) => (v ? undefined : "Campo obrigatório"),
  });
  if (isCancel(appName)) return cancelAndExit();

  const ec2Client = createEc2Client(creds);
  const eicClient = createEc2InstanceConnectClient(creds);

  const keyName = `${appName}-key`;
  const pemPath = `${keyName}.pem`;

  if (!fs.existsSync(pemPath)) {
    try {
      const existing = await ec2Client.send(new DescribeKeyPairsCommand({
        KeyNames: [keyName],
      }));
      if (existing.KeyPairs?.length) {
        log.warn(`Key pair "${keyName}" existe na AWS mas não encontrei ${pemPath} localmente.`);
        log.warn(`Crie um novo ou copie o .pem para este diretório.`);
        return;
      }
    } catch { }

    const result = await ec2Client.send(new CreateKeyPairCommand({
      KeyName: keyName,
      KeyType: "rsa",
    }));
    const pem = result.KeyMaterial;
    if (!pem) {
      log.error("Falha ao obter KeyMaterial do key pair");
      return;
    }
    fs.writeFileSync(pemPath, pem);
    fs.chmodSync(pemPath, 0o400);
    log.success(`Key pair "${keyName}" criado e salvo em ${pemPath}`);
  } else {
    log.info(`Usando key pair existente: ${pemPath}`);
  }

  const sgName = `${appName}-ec2-sg`;
  try {
    const sgs = await ec2Client.send(new DescribeSecurityGroupsCommand({
      Filters: [{ Name: "group-name", Values: [sgName] }],
    }));
    if (sgs.SecurityGroups?.length) {
      const sgId = sgs.SecurityGroups[0].GroupId;
      try {
        await ec2Client.send(new AuthorizeSecurityGroupIngressCommand({
          GroupId: sgId,
          IpPermissions: [{
            IpProtocol: "tcp",
            FromPort: 22,
            ToPort: 22,
            IpRanges: [{ CidrIp: "0.0.0.0/0", Description: "SSH" }],
          }],
        }));
        log.success(`Porta 22 liberada no SG ${sgId}`);
      } catch (err) {
        if ((err as Error).name === "InvalidPermission.Duplicate") {
          log.info("Porta 22 já liberada anteriormente");
        } else {
          throw err;
        }
      }
    } else {
      log.warn(`SG "${sgName}" não encontrado`);
    }
  } catch (err) {
    log.error(`Erro ao configurar SSH SG: ${(err as Error).message}`);
    return;
  }

  try {
    const publicKey = execSync(`ssh-keygen -y -f "${pemPath}"`).toString().trim();
    const instances = await ec2Client.send(new DescribeInstancesCommand({
      Filters: [
        { Name: "tag:Name", Values: [`${appName}-*`] },
        { Name: "instance-state-name", Values: ["running"] },
      ],
    }));
    for (const res of instances.Reservations ?? []) {
      for (const inst of res.Instances ?? []) {
        if (!inst.InstanceId) continue;
        try {
          await eicClient.send(new SendSSHPublicKeyCommand({
            InstanceId: inst.InstanceId,
            InstanceOSUser: "ubuntu",
            SSHPublicKey: publicKey,
            AvailabilityZone: inst.Placement?.AvailabilityZone,
          }));
          log.success(`Chave pública enviada para ${inst.InstanceId}`);
        } catch (eicErr) {
          log.warn(`EC2 Instance Connect falhou: ${(eicErr as Error).message}`);
          log.warn("Tente recriar a infraestrutura (Criar Tudo) para gerar instância com key pair.");
        }
      }
    }
  } catch (err) {
    log.error(`Erro ao extrair chave pública: ${(err as Error).message}`);
    log.info("Certifique-se de ter o ssh-keygen instalado.");
    return;
  }

  try {
    const instances = await ec2Client.send(new DescribeInstancesCommand({
      Filters: [
        { Name: "tag:Name", Values: [`${appName}-*`] },
        { Name: "instance-state-name", Values: ["running"] },
      ],
    }));
    for (const res of instances.Reservations ?? []) {
      for (const inst of res.Instances ?? []) {
        const ip = inst.PublicIpAddress;
        if (ip) {
          log.success(`SSH pronto! Conecte-se:`);
          console.log(`  ssh -i ${pemPath} ubuntu@${ip}`);
          console.log(`  cat /tmp/user-data.log`);
          console.log(`  sudo journalctl -u web-app -n 50 --no-pager`);
        } else {
          log.warn(`Instância ${inst.InstanceId} sem IP público`);
        }
      }
    }
  } catch (err) {
    log.error(`Erro ao buscar IP da EC2: ${(err as Error).message}`);
  }
}
