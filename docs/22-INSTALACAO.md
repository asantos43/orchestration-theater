# 22 — Guia de instalação

> Para quem vai instalar, atualizar ou desinstalar o OTheater, e para o dono, que decide quando ligar a assinatura de código. A referência de arquitetura é a [§5.21 da arquitetura](framework-ideas/arquitetura.md) e o plano é o [docs/21](21-PLANO-DA-FASE-10.md) (P11, N247); este guia diz como usar o que eles decidem e **não os muda**.
>
> Marcas: **[V]** verificado no código deste repositório em 2026-11-24; **[S]** fonte oficial consultada em 2026-11-24 (o endereço vem ao lado, na [seção 9](#9-fontes-consultadas)); **[N]** não confirmado; **[proposta]** escolha minha, que é do dono decidir.
>
> **Estado de hoje:** nenhuma release foi publicada, a chave de atualização do dono ainda não existe (N246) e **o executável e o `.msi` não têm assinatura de código**. O `install.sh` e o `.msi` abaixo descrevem o que a Fase 10 constrói; até o primeiro release (R1) não há o que baixar.

## 1. O que é assinatura de código e o que este projeto faz

Há **duas** assinaturas diferentes, e só a segunda é "assinatura de código":

| Assinatura | O que prova | Quem confere | Estado |
|---|---|---|---|
| **Assinatura da release** (Ed25519, chave do dono) | que o `manifest.json` (e, dentro dele, o SHA-256 de cada arquivo) vem de quem tem a chave privada | `install.sh` e o daemon, **sempre**, antes de instalar ou aplicar **[V]** (`installer/install.sh`, `packages/daemon/src/updates/`) | existe; a chave pública fica embutida no `install.sh` e no executável; a chave privada do dono ainda não foi criada (N246) **[V]** |
| **Assinatura de código** (Authenticode no Windows; Developer ID e notarização da Apple no macOS) | que o arquivo vem de um desenvolvedor identificado por um certificado emitido por uma autoridade | o Windows (SmartScreen) e o macOS (Gatekeeper), na primeira execução | **desligada** (N247): nenhuma conta nem certificado existe **[V]** (`tools/release/release.config.json`) |

A **assinatura *ad hoc*** que o build aplica sempre ao executável do macOS arm64 **não é assinatura de código** no sentido da N247: não tem certificado nem identidade (`codesign --sign -`). Serve só para o binário arm64 modificado conseguir executar **[V]** (`tools/release/src/inject.ts`; a justificativa de que um arm64 sem assinatura não executa está no próprio comentário do código **[N]**: não testei num Mac). Ela **não** impede o aviso do Gatekeeper.

Por isso, hoje, o Windows e o macOS mostram um aviso que o usuário vê porque o arquivo não tem assinatura de código, **não** porque a release esteja errada. A [seção 4](#4-os-avisos-do-smartscreen-e-do-gatekeeper) explica o aviso; a [seção 5](#5-conferir-o-sha-256-e-a-assinatura-a-mão) mostra como conferir a release por conta própria, que é o que o aviso não faz por você.

## 2. Instalar

Todas as instalações são **por usuário**: sem `sudo`, sem administrador, nada fora da sua pasta de usuário **[V]** (`installer/install.sh`, `installer/wix/Product.wxs`: `Scope="perUser"`).

### 2.1. Windows (`.msi`)

1. Baixe `OTheater-<versão>-win32-x64.msi` da página da release, e baixe também `manifest.json` (a [seção 5](#5-conferir-o-sha-256-e-a-assinatura-a-mão) usa o SHA-256 que está nele).
2. Confira o SHA-256 (seção 5.1).
3. Abra o `.msi`. Se o SmartScreen avisar, veja a [seção 4.1](#41-windows-smartscreen).
4. Ou, no PowerShell: `msiexec /i OTheater-<versão>-win32-x64.msi`.

Ao abrir, o `.msi` mostra uma página de opções (N322): onde guardar os segredos, se o daemon sobe no logon e se os adaptadores ACP são baixados já, com o botão Instalar **[V: `installer/wix/Product.wxs`; N: a tela num Windows real]**. Nenhuma das opções precisa de administrador. Sem tela: `msiexec /i ... /qn VAULT=encrypted-file LOGON_SERVICE=0 PREFETCH_ADAPTERS=0` (os padrões são `keep`, `1` e `1`) **[V]** (`installer/wix/README.md`).

O pacote instala o executável como `ot.exe` em `%LOCALAPPDATA%\Programs\OTheater`, põe essa pasta no `PATH` do usuário e registra o serviço de logon (uma Tarefa Agendada, por `ot service install --no-start`: o daemon começa no próximo logon) **[V]** (`installer/wix/README.md`, `Product.wxs`). Abra um terminal novo e rode `ot --version` **[V]** (`packages/daemon/src/cli.ts`).

### 2.2. macOS e Linux (`install.sh`)

```sh
curl -fsSL https://github.com/asantos43/orchestration-theater/releases/latest/download/install.sh | sh
```

O endereço é o da release mais recente do repositório **[proposta]** (é o que o `installer/README.md` documenta; **[N]** ainda não existe release para ele responder). Para quem prefere olhar antes de rodar: baixe o `install.sh`, leia-o (é um script de shell, de uns 900 linhas) e rode `sh install.sh`.

O que o script faz **[V]** (`installer/install.sh`, `installer/README.md`):

1. baixa `manifest.json`, as assinaturas e o executável da sua plataforma;
2. confere a **assinatura do manifesto antes de ler o conteúdo dele** e depois o SHA-256 e o tamanho do executável; o que não confere é apagado e nada fica instalado (código de saída 3);
3. instala o executável em `~/.local/share/otheater/bin/otheater` e o atalho `~/.local/bin/ot`;
4. grava o cofre escolhido (`ot vault use`) e baixa os adaptadores ACP (`ot adapters install`);
5. registra o serviço de logon (`ot service install`): `systemd --user` no Linux, `launchd` no macOS.

Com uma pessoa no terminal, antes de baixar, o script pergunta essas três escolhas (cofre, serviço, adaptadores), com o padrão marcado; `--vault <modo>`, `--no-service`, `--no-prefetch` e `--yes` respondem sem perguntar (N322) **[V]** (`installer/README.md`).

Se `~/.local/bin` não está no seu `PATH`, o script avisa. As variáveis do script (todas opcionais): `OT_INSTALL_CHANNEL` (`stable`, o padrão, ou `beta`), `OT_INSTALL_SERVICE` (`auto`, o padrão, ou `off`: não registra o serviço), `OT_INSTALL_VAULT` (`keep`, o padrão, `keyring`, `encrypted-file` ou `auto`), `OT_INSTALL_PREFETCH` (`auto`, o padrão, ou `off`), `OT_INSTALL_ASK` (`auto`, o padrão, `off` ou `stdin`), `OT_INSTALL_VERIFIER` (`auto`, `openssl`, `ssh-keygen` ou `pinned`), `OT_INSTALL_BASE_URL` (um espelho seu) **[V]**. As demais (`OT_INSTALL_PUBLIC_KEY_FILE`, `OT_INSTALL_OPENSSL`, `OT_INSTALL_ALLOW_KEY_OVERRIDE`) são para testes e espelhos, e trocam quem assina: **não as use para "fazer passar"** uma release que foi recusada.

Depois, `ot --version` mostra a versão, `ot service status` mostra o serviço e `ot init` abre a configuração inicial **[V]** (`packages/daemon/src/cli.ts`).

## 3. Onde ficam as coisas

| | Programa | Dados (a config, o banco, os logs) |
|---|---|---|
| Linux | `~/.local/share/otheater/bin/otheater`, atalho `~/.local/bin/ot` | `$XDG_DATA_HOME/otheater`, ou `~/.local/share/otheater` |
| macOS | o mesmo | `~/Library/Application Support/OTheater` |
| Windows | `%LOCALAPPDATA%\Programs\OTheater\ot.exe` | `%LOCALAPPDATA%\OTheater` |

**[V]** `packages/daemon/src/paths.ts` (as pastas de dados; `OT_DATA_DIR` ou `--data-dir` as trocam), `installer/install.sh` e `installer/wix/Product.wxs`. O programa e os dados ficam em pastas **separadas** de propósito: desinstalar tira o programa e **mantém os dados** (seção 7).

### 3.1. Os arquivos `.tmp` que sobram de uma gravação interrompida

O daemon e o cliente gravam arquivo por "um temporário na mesma pasta, depois um `rename`". Um processo morto (`SIGKILL`, queda de energia) entre os dois deixa `<arquivo>.<pid>[.<hex>].tmp` na pasta **[V]** (`packages/client/src/node/temporaries.ts`). A limpeza apaga **só** o nome exato do arquivo que acabou de ser gravado (nunca por curinga: um arquivo fora do padrão, ou o temporário de outro arquivo, não é tocado) e roda depois de cada gravação com sucesso e, no daemon, ao subir. Uma falha ao apagar é aviso no log e o evento `daemon.notice` com `kind: temporary_cleanup_failed`; a gravação e o início seguem. O comportamento é a seção `temporaries` do `config.yaml` (nome, modos e padrões aceitos pelo dono em 2026-11-24, N306):

| Chave (`temporaries.*`) | Valores | Padrão | O que faz |
|---|---|---|---|
| `cleanup` | `off`, `pid`, `age` | `pid` | `pid` apaga o temporário cujo pid não é um processo vivo (no início, também o do próprio pid, que ali é sobra de um processo anterior com o mesmo pid, como num contêiner); `age` apaga o mais velho que `max_age`, **seja qual for o pid** (para uma pasta que processos de outras máquinas ou contêineres também gravam, onde um pid não diz nada); `off` não apaga nada. |
| `max_age` | duração, de `1m` a `30d` | `1h` | A idade do modo `age`. Os outros modos a ignoram. Abaixo de um minuto, um disco lento poderia fazer a limpeza apagar uma gravação ainda em curso. |

```yaml
temporaries:
  cleanup: age
  max_age: 2h
```

A chave é lida **quando o daemon sobe**. O aplicador da atualização, a CLI e a TUI são processos à parte e usam o padrão (`pid`) **[V]**. Os arquivos cobertos: `daemon-id`, `api-token`, `api.json`, as preferências de layout, a exportação ATIF, `config.yaml`, `plugins.json`, `client.json`, o arquivo de layout do modo `local`, o arquivo de informação do bloqueio da instância, o diário da atualização, os *shims* dos perfis e o addon nativo que o executável único extrai. Os adaptadores também limpam as próprias sobras **[V local]**: o `settings.json` do perfil do Claude Code e o arquivo de cota que o `statusline` grava (varridos a cada preparação do perfil), o `config.toml` do perfil do Codex, o `opencode.json` do perfil do OpenCode (os dois varridos a cada preparação, mesmo sem escrita) e o arquivo do cofre (a cada gravação). Um adaptador não pode importar o cliente, então cada um guarda uma cópia pequena do ajudante (`src/temporaries.ts`, igual nos quatro, e um teste confere que as cópias não divergem). A cópia lê a política da chave `temporaries` e o destino das falhas pelo próprio cliente, quando ele está carregado no mesmo processo (o daemon) **[proposta]**; sem ele, vale o padrão `pid` e a falha é descartada. Os temporários deixados **antes** desta versão também saem **[V local]**: o antigo `settings.json.<pid>.tmp` do Claude Code tem pid e segue a regra acima; os que não têm pid (`.<arquivo do cofre>.<hex>.tmp`, `config.toml.<hex>.tmp`, `opencode.json.<uuid>.tmp`) não dão o que conferir, então são apagados quando ficam mais velhos que `max_age`, tanto no modo `pid` quanto no `age` (decisão do dono, 2026-11-25, N306); no `off`, ficam.

## 4. Os avisos do SmartScreen e do Gatekeeper

Os dois avisos são do **sistema operacional**, não do OTheater, e hoje aparecem porque o arquivo não tem assinatura de código. Tudo o que esta seção diz sobre o comportamento deles vem das páginas oficiais da [seção 9](#9-fontes-consultadas), consultadas em 2026-11-24; o que elas não dizem está marcado **[N]**.

### 4.1. Windows: SmartScreen

- **[S]** A Microsoft descreve duas coisas que o SmartScreen pesa: a reputação de quem publica e a reputação do próprio arquivo (o *hash*). Um arquivo sem assinatura começa sem reputação, e **cada versão nova** do arquivo recomeça do zero (fonte 1).
- **[S]** Para um arquivo sem assinatura, a tabela da Microsoft diz que aparece o aviso "Windows protected your PC" e que o usuário precisa escolher "Run anyway" para o aplicativo rodar; uma política da empresa pode impedir de continuar (fonte 1). Assinar não faz o aviso sumir de imediato: mesmo com certificado válido, o aviso de "não reconhecido" continua até a reputação se formar, o que a Microsoft diz levar semanas e centenas de instalações limpas, e o certificado EV deixou de contornar o SmartScreen (fonte 1). Ou seja: **ligar a assinatura de código (seção 10) não elimina o aviso da primeira release**.
- **[S]** No Windows 11 o Smart App Control pode assumir o lugar do SmartScreen, e, segundo a Microsoft, bloqueia a execução de arquivos sem assinatura que não tenham reputação positiva (fonte 1). Nesse caso a opção "Run anyway" pode não existir; **[N]** a página não diz como proceder, e este guia não manda desligar uma proteção do sistema. Decida isso nas configurações de Segurança do Windows, sabendo o que está desligando.
- **[N]** O texto exato do botão que leva ao "Run anyway" (o link "More info" ou "Mais informações") não está na página consultada, nem como a tela aparece para um `.msi` em vez de um `.exe`. Se a sua tela for diferente, o que vale é a tela do seu Windows.

**Como seguir, se você conferiu a release (seção 5):** na tela do aviso, procure a opção de ver mais informações e depois "Run anyway"/"Executar assim mesmo" **[N: o rótulo]**. Se você **não** conferiu o SHA-256 e a assinatura, confira antes: o aviso só diz "desconhecido", não diz "adulterado".

### 4.2. macOS: Gatekeeper

- **[S]** A Apple diz que o Gatekeeper confere o software baixado de fora da App Store e, por padrão, espera que ele venha de um desenvolvedor identificado, notarizado e sem alteração (fonte 2). Um arquivo que não é assinado e notarizado pode expor o Mac a programas maliciosos (fonte 3).
- **[S]** O caminho que a Apple documenta quando o macOS bloqueia um aplicativo que você decidiu abrir: *Ajustes do Sistema > Privacidade e Segurança*, rolar até a seção de segurança, clicar em **"Abrir Assim Mesmo"** (*Open Anyway*), e confirmar com "Abrir" quando a pergunta voltar; o aplicativo passa a ser uma exceção (fonte 3). A página não fala em prazo para o botão. Em Macs gerenciados por uma organização a opção pode não estar disponível (fonte 3).
- **[N]** Se o `curl | sh` do `install.sh` faz o Gatekeeper reclamar ou não: o `installer/README.md` afirma que ele não marca o arquivo como baixado, mas **nenhuma das páginas da Apple consultadas trata disso**, e eu não testei num Mac. Se o macOS bloquear o executável mesmo assim, use o caminho da Apple acima.
- **[N]** Remover a marca de quarentena à mão (`xattr -d com.apple.quarantine ~/.local/share/otheater/bin/otheater`, citado no `installer/README.md` **[V]**) não está nas páginas da Apple consultadas; é um atalho que só faz sentido depois de você conferir a release (seção 5).

### 4.3. Linux

**[N]** Não consultei fonte sobre avisos de distribuições Linux, e o OTheater não depende de nenhum. O que protege é a conferência do `install.sh` (assinatura e SHA-256) e o fato de tudo ficar na sua pasta de usuário **[V]**.

## 5. Conferir o SHA-256 e a assinatura à mão

O `install.sh` e o daemon já fazem estas conferências sozinhos. Fazê-las à mão serve para o `.msi` (que o `install.sh` não instala) e para quem quer ver com os próprios olhos.

**O que se confere:** a release traz `manifest.json` (a lista dos arquivos, cada um com `name`, `size` e `sha256`), `manifest.json.sig` (a assinatura Ed25519 do manifesto, em base64) e `manifest.json.sshsig` (a mesma assinatura em formato SSHSIG, para o `ssh-keygen`) **[V]** (`packages/daemon/src/updates/manifest.ts`, `tools/release/src/sign.ts`).

### 5.1. O SHA-256 do arquivo

Linux:

```sh
sha256sum OTheater-<versão>-win32-x64.msi
```

macOS:

```sh
shasum -a 256 otheater-darwin-arm64
```

Windows (PowerShell):

```powershell
Get-FileHash .\OTheater-<versão>-win32-x64.msi -Algorithm SHA256
```

O valor tem de ser **igual**, letra por letra (o PowerShell o mostra em maiúsculas; o manifesto, em minúsculas), ao campo `sha256` do arquivo no `manifest.json`. Os comandos são os de cada sistema **[N]**: não os rodei nos três; o `install.sh` usa `sha256sum` ou `shasum -a 256` **[V]**.

### 5.2. A assinatura do manifesto

O SHA-256 do `manifest.json` só vale se o manifesto for autêntico, e é a assinatura que o garante. A chave pública que confere é a que vai **dentro do `install.sh`** da release (entre as linhas `BEGIN embedded public key` e `END embedded public key`, em formato PEM e em uma linha `ssh-ed25519`) e no executável, e a que está em `tools/release/keys/update-public-key.pem` **[V]**. **Hoje esse arquivo é um marcador (`PLACEHOLDER`) até o dono criar a chave (N246):** não há o que conferir antes disso **[V]**. Pegue a chave de um `install.sh` que você obteve **por um caminho independente** do manifesto, por exemplo o do repositório.

Com `openssl` 3 (o LibreSSL do macOS **não** serve **[N]**: o `install.sh` o detecta pela opção `-rawin`):

```sh
openssl base64 -d -A -in manifest.json.sig -out manifest.sig.bin
openssl pkeyutl -verify -pubin -inkey update-public-key.pem -rawin -in manifest.json -sigfile manifest.sig.bin
```

Resposta esperada: `Signature Verified Successfully` **[N]** (a frase exata é do `openssl`; o `install.sh` só olha o código de saída 0). É exatamente o comando do script, com a assinatura decodificada **[V]** (`installer/install.sh`, função `openssl_check`).

Com `ssh-keygen` (o `installer/README.md` diz que o macOS traz o do OpenSSH **[V: a afirmação do README; N: não confirmei num Mac]**):

```sh
# allowed_signers: uma linha só, com a chave pública da release
echo 'otheater namespaces="otheater-release" ssh-ed25519 <a chave da linha EMBEDDED_SSH_KEY>' > allowed_signers
ssh-keygen -Y verify -f allowed_signers -I otheater -n otheater-release -s manifest.json.sshsig < manifest.json
```

Resposta esperada: `Good "otheater-release" signature for otheater with ED25519 key ...` **[N]** (o formato da frase é do `ssh-keygen`; o script só olha o código de saída). O comando é o do script **[V]** (função `ssh_check`).

**Se a conferência falhar, não instale.** Veja a [seção 8](#8-o-installsh-recusou-a-release).

## 6. Atualizar

**Não existe `ot update`** **[V]** (`packages/daemon/src/cli.ts` não tem esse comando). A atualização é do **daemon**, controlada pela seção `updates` do `config.yaml` da pasta de dados, e pelos comandos da API local (`GET /v1/updates`, `POST /v1/updates/check`, `POST /v1/updates/apply`) que a TUI usa **[V]** (`packages/protocol/src/api/updates.ts`).

O daemon baixa o manifesto, **confere a assinatura Ed25519 com a chave que vai dentro do executável** (um arquivo trocado não escolhe quem assina), confere o SHA-256 e o tamanho do executável novo, e só então o aplica; se o novo não subir ou não se sustentar, volta ao anterior **[V]** (`packages/daemon/src/config.ts`, `packages/daemon/src/updates/`). **A assinatura de código não participa dessa conferência.**

Os modos que existem hoje **[V]** (`packages/daemon/src/config.ts`, esquema `UpdatesConfigSchema`, e `packages/protocol/src/api/updates.ts`):

| Chave (`updates.*`) | Valores | Padrão | O que faz |
|---|---|---|---|
| `mode` | `auto`, `notify`, `check`, `off` | `auto` | `auto` baixa, confere e aplica; `notify` baixa e confere e deixa pronto para você aplicar; `check` só avisa que há versão nova; `off` nunca procura. Um daemon que não roda o executável único (um checkout rodado pelo Node) age como `check`. |
| `channel` | `stable`, `beta` | `stable` | `stable` lê a última release; `beta` lê a pré-versão mais nova. Um manifesto de outro canal é recusado. |
| `source` | `github`, `url` | `github` | `github` lê as releases do repositório público, sem credencial; `url` lê `<url>/manifest.json` de um endereço seu. |
| `url` | `https://...` (ou `http://` só em loopback) | (nenhum) | Obrigatória com `source: url`; sem usuário, senha nem *query*. |
| `check_interval` | duração (mínimo `5m`) ou `off` | `6h` | De quanto em quanto tempo procura. `off` só procura quando pedido e uma vez ao iniciar. |
| `apply_when` | `idle`, `park`, `next_start` | `idle` | Quando aplica: `idle` espera nenhuma tentativa estar rodando; `park` para o daemon do jeito limpo na hora (as sessões voltam por `session/load`); `next_start` aplica na próxima partida. |
| `max_wait` | duração | `24h` | Em `idle`, quanto esperar um momento calmo antes de perguntar ao Produtor. |
| `rollback` | `auto`, `off` | `auto` | `auto` volta à versão anterior se a nova não subir ou não se sustentar. |
| `backup_before_migration` | `true`, `false` | `true` | Faz backup antes de uma migração de esquema. |
| `manifest_expiry` | `enforce`, `require`, `off` | `enforce` | O que fazer com o `expires` do manifesto: `enforce` recusa um vencido, `require` recusa também um sem `expires`, `off` ignora. |
| `health_timeout` | duração | `60s` | Quanto esperar o daemon novo responder antes de voltar. |
| `apply.fs_retry` | `auto`, `always`, `off` | `auto` | Se o aplicador repete uma troca de arquivo que o sistema recusou por um instante (`EPERM`, `EBUSY`, `EACCES`: no Windows, o antivírus ou o indexador seguram o arquivo por alguns milissegundos). `auto` repete só no Windows; `always` repete em qualquer sistema; `off` nunca repete (a primeira recusa é a falha). |
| `apply.fs_retry_timeout` | duração, de `1s` a `5m` **[proposta]** | `15s` | Por quanto tempo uma troca de arquivo tenta de novo. Passado o limite, o aplicador desiste com `swap_failed` e volta sozinho à versão anterior; a checagem seguinte tenta de novo. |

As duas últimas ficam num grupo `apply` dentro de `updates` (N305), as outras são chaves diretas **[V]** (`UpdatesConfigSchema`):

```yaml
updates:
  apply:
    fs_retry: auto
    fs_retry_timeout: 15s
```

O daemon grava os dois valores no diário da troca (`update-state.json`) e o aplicador os lê de lá; um diário de antes das chaves, sem os campos, usa `auto` e `15s` **[V: `main.test.ts`]**.

Para só avisar e deixar você decidir, ponha no `config.yaml`:

```yaml
updates:
  mode: notify
```

O que fica **[N]**: se o aviso do SmartScreen ou do Gatekeeper reaparece quando o **daemon** troca o executável (e não um navegador que o baixou). As páginas consultadas falam de arquivos baixados e abertos pelo usuário, não de um programa que troca o próprio executável. Também não testei a atualização num Windows instalado pelo `.msi`: o `.msi` instala o `ot.exe` na pasta do usuário e o daemon troca o arquivo dessa pasta **[V: o desenho em `packages/daemon/src/updates/apply/layout.ts`; N: o efeito real no Windows, que é o P12]**.

## 7. Desinstalar (os dados ficam)

**[V]** Desinstalar remove o programa e o serviço e **não toca nos dados** (a configuração, o banco e os logs ficam na pasta da [seção 3](#3-onde-ficam-as-coisas)).

- **macOS e Linux:** `sh install.sh --uninstall` (o mesmo script, de novo; ou o que ficou salvo). Ele chama `ot uninstall` (que para e tira o serviço), apaga o executável e o atalho `ot` (só se forem dele). Para apagar **também os dados**: `sh install.sh --uninstall --purge-data` (pergunta `[s/N]` antes; sem terminal exige `--yes`). Só apaga uma pasta que tenha `config.yaml`, `store.sqlite` ou `daemon-id`, e nunca a raiz nem o seu HOME. O chaveiro do sistema não é tocado.
- **Qualquer sistema, só o serviço:** `ot uninstall` (tira o serviço e mantém os dados; `--purge-data` e `--yes` valem como acima) ou `ot service uninstall` (só o serviço).
- **Windows:** em *Configurações > Aplicativos*, ou `msiexec /x OTheater-<versão>-win32-x64.msi`. O pacote remove o executável, o `PATH` e a Tarefa Agendada; a pasta `%LOCALAPPDATA%\OTheater` **não é do pacote** e fica **[V]** (`installer/wix/Product.wxs`, `installer/wix/README.md`).

Para apagar os dados à mão, depois de desinstalar: apague a pasta da tabela da seção 3. Isso **não tem volta**; antes, `ot backup` faz uma cópia **[V]** (`packages/daemon/src/cli.ts`).

## 8. O `install.sh` recusou a release

O script **falha fechado**: o que não conferiu é apagado e nada fica instalado. O código de saída 3 diz "a release não conferiu" **[V]**:

| Mensagem (a causa) | O que é | O que fazer |
|---|---|---|
| a assinatura não confere | o manifesto não foi assinado pela chave do dono, ou foi mudado depois | **Não force.** Baixe de novo; se repetir, é o arquivo ou o caminho (um espelho, um *proxy*). Não existe opção "ignorar assinatura". |
| nenhum verificador disponível | o sistema não tem `openssl` 3, nem `ssh-keygen` com o formato SSHSIG, nem o SHA-256 fixado no script | Instale um (no macOS: `brew install openssl@3` e rode `OT_INSTALL_OPENSSL=$(brew --prefix openssl@3)/bin/openssl OT_INSTALL_ALLOW_KEY_OVERRIDE=1 sh install.sh`, que o `installer/README.md` documenta **[V]**) ou use `OT_INSTALL_VERIFIER=ssh-keygen`. |
| o manifesto venceu | o `expires` do manifesto passou (a validade é de 365 dias por padrão, `manifestValidityDays` **[V]**) | Há uma release mais nova: baixe o `install.sh` dela. Um manifesto vencido é recusado de propósito, para uma release antiga e com falha conhecida não ficar instalável para sempre. |
| SHA-256 ou tamanho do arquivo | o executável baixado não é o do manifesto | Baixe de novo; se repetir, **não instale**: é adulteração ou um espelho quebrado. |
| canal diferente | o manifesto é de `beta` e você pediu `stable`, ou o contrário | Ajuste `OT_INSTALL_CHANNEL`. |

**[V]** Todos acabam em código 3, e nenhum deixa arquivo instalado. Código 1 é falha de rede ou de sistema sem suporte; 2, uso errado; 4, instalado mas o passo do serviço falhou (o executável e o atalho ficam; rode `ot service install` depois) (`installer/README.md`).

Se a recusa persistir com um arquivo que você baixou da página oficial, **abra uma *issue* no repositório com a mensagem do script**; não procure um caminho para passar por cima dela.

## 9. Fontes consultadas

Todas em 2026-11-24, só leitura. A regra do repositório é não afirmar o que um sistema permite sem citar a fonte e a data; o que as páginas **não** dizem está marcado **[N]** no texto.

| # | Fonte | Endereço | Data da página | O que se tirou dela |
|---|---|---|---|---|
| 1 | Microsoft Learn, "SmartScreen reputation for Windows app developers" **[S]** | https://learn.microsoft.com/windows/apps/package-and-deploy/smartscreen-reputation | `ms.date` 2026-05-04 | as duas reputações; arquivo sem assinatura começa sem reputação a cada versão; "Run anyway"; EV não contorna; tempo para formar reputação; Smart App Control |
| 2 | Apple Platform Security, "Gatekeeper and runtime protection" **[S]** | https://support.apple.com/guide/security/gatekeeper-and-runtime-protection-sec5599b66df/web | publicada em 2024-12-19 | o que o Gatekeeper espera por padrão (desenvolvedor identificado, notarizado, sem alteração) |
| 3 | Apple Support, "Safely open apps on your Mac" **[S]** | https://support.apple.com/en-us/102445 | publicada em 2026-05-27 | o caminho "Abrir Assim Mesmo" em Privacidade e Segurança; Macs gerenciados |
| 4 | Apple Developer, "Notarizing macOS software before distribution" e "Customizing the notarization workflow" **[S]** | https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution e https://developer.apple.com/documentation/security/customizing-the-notarization-workflow | não anotada | a notarização exige certificado Developer ID, *hardened runtime* e *timestamp*; `notarytool submit --wait`; um binário avulso **não pode receber o *ticket* grampeado** (*staple*) |
| 5 | Microsoft Learn, "SignTool" **[S]** | https://learn.microsoft.com/en-us/windows/win32/seccrypto/signtool | `ms.date` 2026-10-28 | `signtool sign /f /p /fd SHA256 /tr /td SHA256` e `signtool verify /pa /v` |

## 10. Ligar a assinatura de código (para o dono)

Nada disto está ligado, e **nenhuma conta nem certificado foi criado**: as contas pagas e os certificados são do dono (N247). O passo de assinar está pronto no `.github/workflows/release.yml` e desligado por padrão. As chaves e os nomes abaixo são **[proposta]** (o plano fixa só `signing.windows` e `signing.macos`).

**As chaves** (`tools/release/release.config.json`, bloco `signing`; a variável de repositório com o mesmo efeito, quando existe, vale mais que o arquivo) **[V]**:

| Chave | Variável de repositório | Valores | Padrão |
|---|---|---|---|
| `signing.windows` | `OT_SIGNING_WINDOWS` | `off`, `signtool` | `off` |
| `signing.macos` | `OT_SIGNING_MACOS` | `off`, `codesign` | `off` |

Com uma chave ligada, o job `signing` do `release.yml` confere, **antes de compilar qualquer coisa**, que os *secrets* existem e não estão vazios; se faltar algum, o job falha com a lista dos que faltam e **nada é compilado nem publicado**. Os *secrets* **[proposta]**:

| Plataforma | Secrets |
|---|---|
| Windows (`signtool`) | `OT_WINDOWS_SIGNING_CERT_BASE64` (o `.pfx` em base64) e `OT_WINDOWS_SIGNING_CERT_PASSWORD` |
| macOS (`codesign`) | `OT_MACOS_SIGNING_CERT_BASE64` (o `.p12` do certificado "Developer ID Application" em base64), `OT_MACOS_SIGNING_CERT_PASSWORD`, `OT_MACOS_SIGNING_IDENTITY` (o nome do certificado), `OT_MACOS_NOTARY_APPLE_ID`, `OT_MACOS_NOTARY_PASSWORD` (senha específica de aplicativo) e `OT_MACOS_NOTARY_TEAM_ID` |

Opcional: a variável `OT_SIGNING_TIMESTAMP_URL` (servidor de carimbo de tempo RFC 3161; padrão `http://timestamp.digicert.com` **[proposta]**).

O que o `release.yml` faz com a chave ligada **[V]: a forma, conferida pelo teste `tools/release/src/release-workflow.test.ts`; [N]: nada disto rodou, porque não há certificado**:

- **Windows:** assina o `.exe` e o `.msi` com `signtool sign ... /fd SHA256 /tr <carimbo> /td SHA256` e confere com `signtool verify /pa /v` (fonte 5).
- **macOS:** assina o binário com `codesign --force --options runtime --timestamp` (substituindo a assinatura *ad hoc*), confere que a assinatura tem a autoridade "Developer ID Application" e envia para notarização com `notarytool submit --wait`, que tem de terminar `Accepted` (fonte 4). **Não há `staple`**: a Apple não grampeia o *ticket* num binário avulso, então o Gatekeeper o procura pela rede (fonte 4).
- Os arquivos assinados são enviados de novo com o mesmo nome de artefato, **antes** de o manifesto calcular o SHA-256, que portanto é o do arquivo assinado.
- Só roda na `main` (o certificado não é para uma *branch*) **[proposta]**.
- Os *secrets* de assinatura são lidos só pelos três jobs de assinatura, nunca pelo job `publish` nem pelo ensaio.

O que **não** está resolvido, e é decisão do dono **[N]**:

1. **O `ot.exe` dentro do `.msi` sai sem assinatura.** O `.msi` embute uma compilação separada do executável (`.github/workflows/dist-msi.yml`), que o passo de assinar não alcança; só o `.msi` em si e o `otheater-win32-x64.exe` solto são assinados. Assinar o de dentro exige mexer no `dist-msi.yml`, que este passo não toca.
2. **Os *entitlements* do macOS** (`tools/release/macos-entitlements.plist`: `allow-jit`, `allow-unsigned-executable-memory`, `disable-library-validation`) são o que se espera que um Node precise com o *hardened runtime*, **mas não foram testados com certificado real**. A primeira notarização de verdade mostra o que sobra.
3. **A notarização de um binário avulso** (sem `.app` nem `.pkg`): a Apple o aceita para envio (fonte 4), mas **[N]** não testei, e ele não leva o *ticket* grampeado.
4. **O aviso não some na primeira release**, mesmo assinada (seção 4.1, fonte 1): a reputação se forma com o tempo.
5. **`actions/upload-artifact@v4` com `overwrite: true`**: a página do projeto documenta a opção, mas não diz a partir de qual versão 4.x; fixei `@v4` **[N]**. Se o primeiro uso falhar aqui, é o primeiro lugar a olhar.
6. **Os nomes dos *secrets* e das variáveis**, o servidor de carimbo e a regra "só da `main`" acima.
