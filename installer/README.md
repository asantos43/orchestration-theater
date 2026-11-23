# Instaladores do OTheater

Fase 10, passo P5. Esta pasta tem o instalador de macOS e Linux. O de Windows (MSI) é de outro passo (`installer/wix/`).

## install.sh (macOS e Linux)

```sh
curl -fsSL https://github.com/asantos43/orchestration-theater/releases/latest/download/install.sh | sh
```

[proposta] O endereço do `install.sh` nas Releases depende do passo P9 (nomes dos arquivos da release). Até lá, rode o script do repositório: `sh installer/install.sh`.

O que ele faz (tudo por usuário, sem `sudo`, sem escrever fora do HOME):

1. baixa só três arquivos da release: `manifest.json`, `manifest.json.sig` e o executável da sua plataforma (`linux-x64` ou `darwin-arm64`; outras plataformas saem com erro);
2. confere a assinatura Ed25519 do manifesto e depois o tamanho e o SHA-256 do executável, que estão dentro do manifesto assinado;
3. instala o executável em `~/.local/share/otheater/bin/otheater` [proposta: a subpasta `bin/` separa o executável dos dados do daemon, que no Linux ficam na mesma pasta] e cria o link `~/.local/bin/ot`;
4. registra o serviço de logon com `ot service install` (a menos que `OT_INSTALL_SERVICE=off`);
5. diz o que falta: o `PATH`, os adaptadores ACP (`claude-agent-acp` e outros) e o `loginctl enable-linger` no Linux.

Ele falha fechado: o que não confere é apagado, nada é instalado e o código de saída não é zero.

### Variáveis

| Variável                     | Valores                  | Padrão                                | Efeito                                                                                          |
| ---------------------------- | ------------------------ | ------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `OT_INSTALL_CHANNEL`         | `stable`, `beta`         | `stable`                              | Canal. O manifesto assinado precisa ser desse canal.                                            |
| `OT_INSTALL_SERVICE`         | `auto`, `off`            | `auto`                                | `auto` registra o serviço de logon; `off` só instala os arquivos.                               |
| `OT_INSTALL_BASE_URL`        | `https://...` ou loopback | Releases do repositório               | Onde estão os arquivos (espelho ou teste). `http` só em loopback; sem usuário e senha na URL.   |
| `OT_INSTALL_OPENSSL`         | caminho                  | `openssl` do PATH                     | O openssl que confere Ed25519 (precisa ser o 3 ou mais; o LibreSSL do macOS não confere).       |
| `OT_INSTALL_PUBLIC_KEY_FILE` | arquivo PEM              | a chave embutida no script            | Só para testes e espelhos; imprime um aviso.                                                    |
| `OT_DATA_DIR`                | pasta                    | a pasta de dados do daemon            | Usada pelo `--uninstall --purge-data`.                                                          |

Todas são chaves de configuração do instalador com modos e padrão documentado (regra do projeto); não há outro padrão escondido no script.

### Argumentos

- `--uninstall`: para e remove o serviço (`ot uninstall`), apaga o executável e o link `ot` (só se for dele). Os dados ficam.
- `--uninstall --purge-data`: apaga também a pasta de dados. Pergunta antes (`[y/N]`); sem terminal, exige `--yes`. Só apaga uma pasta que tenha `config.yaml`, `store.sqlite` ou `daemon-id`, e nunca a raiz nem o HOME. O chaveiro do sistema não é tocado.
- `--help`.

### Códigos de saída

| Código | Significado                                                                             |
| ------ | --------------------------------------------------------------------------------------- |
| 0      | Pronto.                                                                                 |
| 1      | Falhou: rede, sistema sem suporte, o executável não roda.                               |
| 2      | Uso errado (argumento, variável ou HOME inválidos; `--purge-data` sem confirmação).     |
| 3      | A release não conferiu (assinatura, SHA-256, tamanho ou canal). Nada foi instalado.     |
| 4      | Instalado, mas o passo do serviço falhou (o executável e o link ficam).                 |

### Modelo de confiança

- A chave pública Ed25519 vai dentro do script (o job de release do P9 troca a linha `EMBEDDED_PUBLIC_KEY`; até lá é `PLACEHOLDER`). O manifesto é assinado pela chave privada do dono, que só existe como segredo da CI.
- Com um `openssl` 3 ou mais, o script confere a assinatura com a chave do script, sem baixar nada executável antes.
- Sem esse openssl (o macOS traz LibreSSL), o script baixa o executável, confere o SHA-256 dele contra o manifesto e pede ao próprio executável que confira a assinatura (`--ot-internal=verify-release`, N253). Isso confia no que acabou de ser baixado e o script imprime um aviso. Alternativa: `brew install openssl@3` e `OT_INSTALL_OPENSSL=$(brew --prefix openssl@3)/bin/openssl`.
- O canal `beta` no endereço padrão faz uma requisição a mais, à lista de releases, para achar a pré-versão mais recente.
- [N] O executável não tem assinatura de código da Apple nem da Microsoft (decisão de partida da Fase 10). No macOS o Gatekeeper pode reclamar de um binário baixado pelo navegador; o `curl | sh` não marca o arquivo como baixado, então em geral não reclama. Se reclamar: `xattr -d com.apple.quarantine ~/.local/share/otheater/bin/otheater`.

### Testes

- `packages/daemon/src/updates/install-sh.test.ts`: roda o script de verdade com HOME temporário, um servidor de releases em loopback e arquivos assinados por uma chave feita no teste. O `ot` é um falso que só registra as chamadas, então nenhum serviço é tocado. Cobre instalar, recusar assinatura ruim (e SHA, tamanho, canal), desinstalar e `--purge-data`.
- `packages/daemon/src/updates/install-sh-real.test.ts` e `.github/workflows/dist-install-sh.yml`: o mesmo com o executável único real e o serviço real, só na CI (`OT_TEST_REAL_SERVICE=1`, `CI=true`) em ubuntu e macOS.
