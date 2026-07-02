import {
  intro,
  outro,
  select,
  isCancel,
  cancel,
  text,
  password,
} from "@clack/prompts";
import type { AwsCredentials } from "./types/index.js";
import { createAll } from "./commands/create-all.js";
import { cleanupAll } from "./commands/cleanup-all.js";
import { diagnose } from "./commands/diagnose.js";
import { setupSsh } from "./commands/ssh.js";

async function collectCredentials(): Promise<AwsCredentials> {
  const accessKeyId = await text({
    message: "AWS Access Key ID",
    validate: (v) => (v ? undefined : "Campo obrigatório"),
  });
  if (isCancel(accessKeyId)) cancelAndExit();

  const secretAccessKey = await password({
    message: "AWS Secret Access Key",
    validate: (v) => (v ? undefined : "Campo obrigatório"),
  });
  if (isCancel(secretAccessKey)) cancelAndExit();

  const sessionToken = await password({
    message: "AWS Session Token (Learner Labs)",
    validate: (v) => (v ? undefined : "Campo obrigatório"),
  });
  if (isCancel(sessionToken)) cancelAndExit();

  const region = await text({
    message: "AWS Region",
    initialValue: "us-east-1",
    validate: (v) => (v ? undefined : "Campo obrigatório"),
  });
  if (isCancel(region)) cancelAndExit();

  return {
    accessKeyId: accessKeyId as string,
    secretAccessKey: secretAccessKey as string,
    sessionToken: sessionToken as string,
    region: region as string,
  };
}

function cancelAndExit(): never {
  cancel("Operação cancelada");
  process.exit(0);
}

async function main() {
  intro("AWS Cloud CLI - Trabalho Final");

  const creds = await collectCredentials();

  const option = await select({
    message: "Selecione o recurso a ser criado",
    options: [
      { value: "all", label: "Criar Tudo", hint: "VPC + EC2 + RDS + ALB" },
      { value: "cleanup-all", label: "Deletar Tudo", hint: "Remove toda a infraestrutura" },
      { value: "diagnose", label: "Diagnosticar", hint: "Verifica saúde da infraestrutura" },
      { value: "ssh", label: "SSH", hint: "Libera SSH e mostra comando de conexão" },
      { value: "quit", label: "Sair", hint: "Encerra a aplicação"}
    ],
  });
  if (isCancel(option)) cancelAndExit();

  switch (option) {
    case "all":
      await createAll(creds);
      break;
    case "cleanup-all":
      await cleanupAll(creds);
      break;
    case "diagnose":
      await diagnose(creds);
      break;
    case "ssh":
      await setupSsh(creds);
      break;
    case "quit":
      cancelAndExit();
      break;
    default:
      outro("Opção inválida");
      process.exit(1);
  }

  outro("Operação finalizada");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});