# AWS Cloud CLI — Trabalho Final

**Equipe**: Gustavo Henrique da Silva Kubiack, Maria Eduarda Nichelle Ferreira

CLI interativa em TypeScript para provisionar, diagnosticar e destruir uma infraestrutura completa na AWS (VPC, EC2, RDS e Application Load Balancer), voltada para deploy automatizado da aplicação [`to-do-fastapi`](https://github.com/gustavokubiack/to-do-fastapi).

## Índice

- [Visão geral](#visão-geral)
- [Arquitetura provisionada](#arquitetura-provisionada)
- [Pré-requisitos](#pré-requisitos)
- [Instalação](#instalação)
- [Uso](#uso)
  - [Criar Tudo](#criar-tudo)
  - [Diagnosticar](#diagnosticar)
  - [SSH](#ssh)
  - [Deletar Tudo](#deletar-tudo)
- [Scripts disponíveis](#scripts-disponíveis)
- [Estrutura do projeto](#estrutura-do-projeto)
- [Variáveis de ambiente da aplicação implantada](#variáveis-de-ambiente-da-aplicação-implantada)
- [Solução de problemas](#solução-de-problemas)
- [Licença](#licença)

## Visão geral

Este projeto é uma ferramenta de linha de comando (CLI) que automatiza a criação de recursos na AWS necessários para hospedar uma aplicação web com banco de dados, atrás de um load balancer. A CLI foi construída com [`@clack/prompts`](https://github.com/bombshell-dev/clack) para uma experiência interativa no terminal e usa o [AWS SDK v3](https://github.com/aws/aws-sdk-js-v3) para se comunicar com os serviços da AWS.

Principais funcionalidades:

- **Criar Tudo**: provisiona VPC (ou reaproveita a VPC padrão), subnets, Internet Gateway, Security Groups, instância RDS (PostgreSQL), duas instâncias EC2 rodando a aplicação via `systemd`, Target Group e Application Load Balancer.
- **Diagnosticar**: verifica o estado atual de todos os recursos (EC2, RDS, Target Group/health checks, ALB, Security Groups) e mostra o console output das instâncias EC2 para depuração.
- **SSH**: cria/gerencia um key pair, libera a porta 22 no Security Group da aplicação e envia a chave pública via EC2 Instance Connect para permitir acesso SSH temporário às instâncias.
- **Conectar ao Banco**: automatiza o acesso ao RDS (que é privado) usando a instância EC2 como bastion — prepara o SSH e abre um `psql` interativo direto no terminal ou um túnel SSH (port forward) para uso com ferramentas gráficas como DBeaver, TablePlus ou pgAdmin.
- **Deletar Tudo**: remove toda a infraestrutura criada (ALB, Target Group, EC2, RDS, Security Groups, Subnets, Internet Gateway e VPC), com lógica de retry para lidar com dependências assíncronas da AWS (ex: ENIs que demoram a ser liberadas).

## Arquitetura provisionada

```
                         Internet
                            │
                    ┌───────▼────────┐
                    │  Application    │
                    │  Load Balancer  │  (porta 80)
                    └───────┬────────┘
                            │
              ┌─────────────┴─────────────┐
              │                           │
       ┌──────▼──────┐            ┌──────▼──────┐
       │   EC2 #1     │            │   EC2 #2     │   (porta 3000)
       │ (subnet AZ-a)│            │ (subnet AZ-b)│
       └──────┬──────┘            └──────┬──────┘
              │                           │
              └─────────────┬─────────────┘
                             │
                      ┌──────▼──────┐
                      │     RDS      │  (PostgreSQL, porta 5432)
                      │  (privado)   │
                      └─────────────┘
```

Cada instância EC2 recebe um script `user-data` que instala Python, clona o repositório da aplicação (`to-do-fastapi`), configura um virtualenv e registra um serviço `systemd` (`web-app`) que sobe a aplicação com `uvicorn` na porta `3000`, apontando para o banco RDS criado.

## Pré-requisitos

- [Node.js](https://nodejs.org/) 18+ (recomendado 20+)
- Conta AWS com credenciais temporárias (Access Key ID, Secret Access Key e Session Token — pensado para ambientes como **AWS Academy Learner Lab**)
- Permissões IAM para criar/deletar recursos de EC2, RDS, ELBv2 e VPC
- `ssh-keygen` disponível no `PATH` (necessário apenas para o comando `SSH`)

## Instalação

```bash
git clone https://github.com/gustavokubiack/trabalho-final-cloud-cli.git
cd trabalho-final-cloud-cli
npm install
```

## Uso

Modo desenvolvimento (via `tsx`, sem precisar compilar):

```bash
npm run dev
```

Ou compilar e rodar o build:

```bash
npm run build
npm start
```

Ao iniciar, a CLI solicita as credenciais AWS:

```
AWS Access Key ID
AWS Secret Access Key
AWS Session Token (Learner Labs)
AWS Region (padrão: us-east-1)
```

Em seguida, exibe o menu principal:

```
Selecione o recurso a ser criado
❯ Criar Tudo         VPC + EC2 + RDS + ALB
  Deletar Tudo        Remove toda a infraestrutura
  Diagnosticar        Verifica saúde da infraestrutura
  SSH                 Libera SSH e mostra comando de conexão
  Conectar ao Banco   SSH + psql interativo ou túnel para o RDS
  Sair                Encerra a aplicação
```

### Criar Tudo

Solicita:

| Campo | Descrição | Padrão |
|---|---|---|
| Nome do projeto/aplicação | Usado como prefixo em todos os recursos (`{appName}-vpc`, `{appName}-alb`, etc.) | `app-cloud` |
| AMI ID | Imagem Ubuntu 24.04 LTS | `ami-0e86e20dae9224db8` |
| Tipo de instância EC2 | `t2.micro`, `t2.small`, `t2.medium`, `t3.micro`, `t3.small` | — |
| Classe da instância RDS | `db.t3.micro`, `db.t3.small`, `db.t3.medium` | — |
| Usuário mestre do banco | — | — |
| Senha do banco | mínimo 8 caracteres | — |
| Armazenamento RDS (GB) | mínimo 20 GB | `20` |

O comando:

1. Reaproveita a VPC padrão da região (ou cria uma nova com Internet Gateway, subnets, route table, etc.)
2. Cria os Security Groups do ALB, das EC2s e do RDS, liberando apenas o tráfego necessário entre camadas
3. Cria o DB Subnet Group e a instância RDS, aguardando ficar disponível
4. Sobe duas instâncias EC2 (uma por subnet/AZ) com o `user-data` que instala e inicia a aplicação
5. Cria o Target Group, registra as instâncias e cria o Load Balancer com listener HTTP:80
6. Ao final, imprime o DNS do ALB para acesso à aplicação

### Diagnosticar

Pede o nome do projeto e verifica, para os recursos com esse prefixo:

- Estado das instâncias EC2 (IP público/privado)
- Status e endpoint do RDS
- Health check dos targets no Target Group
- Estado e DNS do Load Balancer
- Regras dos Security Groups
- Últimas 200 linhas do console output de cada EC2, destacando linhas com palavras-chave (`npm`, `node`, `Error`, `listen`, `fail`, etc.)

Útil para depurar falhas de deploy sem precisar entrar via SSH.

### SSH

Pede o nome do projeto e:

1. Cria (ou reutiliza) um key pair `.pem` local
2. Libera a porta 22 no Security Group das EC2s
3. Envia a chave pública para as instâncias em execução via **EC2 Instance Connect** (acesso temporário, sem precisar embutir a chave na criação da instância)
4. Imprime o comando pronto para conectar:

```bash
ssh -i {appName}-key.pem ubuntu@{IP_PUBLICO}
```

### Conectar ao Banco

O RDS é provisionado como **privado** (`PubliclyAccessible: false`) e seu Security Group só aceita conexões vindas do Security Group das EC2s. Por isso não é possível conectar direto do seu computador — é preciso passar pela EC2 como bastion. Esse comando automatiza esse fluxo:

1. Pede o nome do projeto e busca o endpoint do RDS (`{appName}-db`)
2. Pede o usuário e o nome do banco (padrão `appdb`)
3. Prepara o acesso SSH à EC2 (mesma lógica do comando `SSH`, reaproveitada internamente)
4. Pergunta como você quer se conectar:
   - **psql interativo** — abre uma sessão SSH que já executa `psql` direto na instância EC2 (instalando o `postgresql-client` automaticamente se necessário);
   - **Túnel SSH (port forward)** — abre um túnel `ssh -L` entre uma porta local (padrão `5433`) e o RDS, permitindo conectar ferramentas gráficas como **DBeaver**, **TablePlus** ou **pgAdmin** em `localhost:<porta>`.

No modo túnel, o processo fica em primeiro plano até você pressionar `Ctrl+C`.

### Deletar Tudo

Pede o nome do projeto, confirma a ação e remove, na ordem correta de dependência:

1. Listener e Load Balancer
2. Target Group
3. Instâncias EC2 (aguardando terminação)
4. Instância RDS e DB Subnet Group
5. Interfaces de rede (ENIs) pendentes, com retries
6. Security Groups
7. Subnets, Route Tables, Internet Gateway e VPC

## Scripts disponíveis

| Script | Descrição |
|---|---|
| `npm run dev` | Executa a CLI diretamente com `tsx`, sem build |
| `npm run build` | Compila o TypeScript para `dist/` |
| `npm start` | Executa o build compilado (`dist/index.js`) |
| `npm test` | Roda os testes com Vitest |
| `npm run test:watch` | Roda os testes em modo watch |
| `npm run lint` | Executa o ESLint em `src/` |
| `npm run typecheck` | Verifica tipos sem gerar output (`tsc --noEmit`) |

## Estrutura do projeto

```
trabalho-final-cloud-cli/
├── src/
│   ├── commands/
│   │   ├── create-all.ts    # Provisiona VPC + EC2 + RDS + ALB
│   │   ├── cleanup-all.ts   # Remove toda a infraestrutura
│   │   ├── diagnose.ts      # Diagnóstico de saúde dos recursos
│   │   └── ssh.ts           # Gerencia acesso SSH via EC2 Instance Connect
│   ├── lib/
│   │   └── aws.ts           # Factories dos clients do AWS SDK (EC2, RDS, ELBv2, S3, EC2 Instance Connect)
│   ├── types/
│   │   └── index.ts         # Tipos compartilhados (ex: AwsCredentials)
│   └── index.ts             # Entry point / menu interativo
├── package.json
├── tsconfig.json
└── .eslintrc.json
```

## Variáveis de ambiente da aplicação implantada

As instâncias EC2 sobem a aplicação (`to-do-fastapi`) via `systemd`, injetando as seguintes variáveis de ambiente definidas pelo `user-data`:

| Variável | Origem |
|---|---|
| `DB_HOST` | Endpoint da instância RDS criada |
| `DB_PORT` | `5432` (PostgreSQL) |
| `DB_USER` | Usuário mestre informado na CLI |
| `DB_PASSWORD` | Senha informada na CLI |
| `DB_NAME` | `appdb` |
| `DB_ENGINE` | `postgres` |
| `APP_NAME` | Nome do projeto informado na CLI |

A aplicação escuta na porta `3000`, que é o alvo registrado no Target Group do ALB.

## Solução de problemas

- **RDS demora muito para ficar disponível**: o comando aguarda até 15 minutos (`maxWaitTime: 900`). Em caso de timeout, rode `Diagnosticar` para verificar o status atual.
- **Falha ao deletar VPC**: geralmente causada por ENIs (Elastic Network Interfaces) que ainda não foram liberadas pela AWS. O `cleanup-all` já faz retry automático aguardando a liberação; se persistir, rode `Deletar Tudo` novamente.
- **SSH falha com "EC2 Instance Connect falhou"**: a instância precisa ter sido criada nesta mesma execução da CLI (para ter o Security Group correto). Recrie a infraestrutura com `Criar Tudo` se necessário.
- **Erro `InvalidPermission.Duplicate`**: é tratado silenciosamente — significa que a regra do Security Group já existia.

## Licença

ISC
