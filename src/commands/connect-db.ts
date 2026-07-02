import { text, select, isCancel, cancel, log, spinner } from "@clack/prompts";
import { spawnSync } from "node:child_process";
import { DescribeDBInstancesCommand } from "@aws-sdk/client-rds";
import { createRdsClient } from "../lib/aws.js";
import { ensureSshAccess } from "./ssh.js";
import type { AwsCredentials } from "../types/index.js";

function cancelAndExit(): never {
  cancel("Operação cancelada");
  process.exit(0);
}

export async function connectDb(creds: AwsCredentials) {
  const appName = await text({
    message: "Nome do projeto/aplicação",
    validate: (v) => (v ? undefined : "Campo obrigatório"),
  });
  if (isCancel(appName)) return cancelAndExit();

  const rdsClient = createRdsClient(creds);

  const dbSpin = spinner();
  dbSpin.start("Buscando endpoint do RDS...");

  let dbHost = "";
  let dbPort = "5432";

  try {
    const { DBInstances } = await rdsClient.send(new DescribeDBInstancesCommand({
      DBInstanceIdentifier: `${appName}-db`,
    }));
    const db = DBInstances?.[0];
    dbHost = db?.Endpoint?.Address ?? "";
    dbPort = String(db?.Endpoint?.Port ?? 5432);
    if (!dbHost) throw new Error("Endpoint não encontrado");
    dbSpin.stop(`RDS encontrado: ${dbHost}:${dbPort}`);
  } catch (err) {
    dbSpin.stop("Erro ao buscar RDS");
    log.error(`Erro: ${(err as Error).message}`);
    log.info("Confirme se a infraestrutura já foi criada (opção Criar Tudo) e se o nome do projeto está correto.");
    return;
  }

  const dbUsername = await text({
    message: "Usuário do banco",
    validate: (v) => (v ? undefined : "Campo obrigatório"),
  });
  if (isCancel(dbUsername)) return cancelAndExit();

  const dbName = await text({
    message: "Nome do banco",
    initialValue: "appdb",
    validate: (v) => (v ? undefined : "Campo obrigatório"),
  });
  if (isCancel(dbName)) return cancelAndExit();

  log.info("Preparando acesso SSH à instância EC2 (usada como bastion até o RDS)...");
  const access = await ensureSshAccess(creds, appName as string);
  if (!access) {
    log.error("Não foi possível preparar o acesso SSH. Veja as mensagens acima.");
    return;
  }
  const { pemPath, publicIp } = access;

  const mode = await select({
    message: "Como você quer se conectar ao banco?",
    options: [
      { value: "psql", label: "psql interativo", hint: "Abre um shell psql direto via SSH na EC2" },
      { value: "tunnel", label: "Túnel SSH (port forward)", hint: "Usa DBeaver, TablePlus, pgAdmin etc. localmente" },
    ],
  });
  if (isCancel(mode)) return cancelAndExit();

  if (mode === "psql") {
    log.info("Conectando via SSH e abrindo psql (instala o cliente na EC2 se necessário)...");
    const remoteCmd =
      `which psql > /dev/null 2>&1 || (sudo apt-get update -qq && sudo apt-get install -y -qq postgresql-client); ` +
      `psql -h ${dbHost} -p ${dbPort} -U ${dbUsername} -d ${dbName}`;

    const result = spawnSync(
      "ssh",
      ["-t", "-i", pemPath, `ubuntu@${publicIp}`, remoteCmd],
      { stdio: "inherit" }
    );
    if (result.error) {
      log.error(`Erro ao conectar: ${result.error.message}`);
    }
    return;
  }

  const localPort = await text({
    message: "Porta local para o túnel",
    initialValue: "5433",
    validate: (v) => (!isNaN(Number(v)) && Number(v) > 0 ? undefined : "Informe um número de porta válido"),
  });
  if (isCancel(localPort)) return cancelAndExit();

  log.success(
    `Túnel pronto! Conecte sua ferramenta (DBeaver, TablePlus, pgAdmin...) em localhost:${localPort}, ` +
    `usuário "${dbUsername}", banco "${dbName}".`
  );
  log.info("O túnel fica aberto neste terminal. Pressione Ctrl+C para encerrá-lo.");

  spawnSync(
    "ssh",
    ["-i", pemPath, "-L", `${localPort}:${dbHost}:${dbPort}`, "-N", `ubuntu@${publicIp}`],
    { stdio: "inherit" }
  );
}
