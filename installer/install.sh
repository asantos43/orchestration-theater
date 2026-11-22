#!/bin/sh
# SPDX-License-Identifier: MPL-2.0
#
# OTheater installer for macOS and Linux (Phase 10, step P5; docs/21, N248).
#
#   install:    sh install.sh
#   uninstall:  sh install.sh --uninstall [--purge-data] [--yes]
#
# It downloads the release (manifest.json, manifest.json.sig and the executable of this platform),
# checks the Ed25519 signature of the manifest and the SHA-256 of the executable, installs both for
# the current user and registers the logon service (`ot service install`). No sudo, nothing outside
# the HOME folder, no download beyond those files. It fails closed: whatever does not check is
# deleted and the exit code is not zero. See installer/README.md.
#
# Variables (documented in installer/README.md):
#   OT_INSTALL_BASE_URL   where the release files are (default: GitHub Releases of the repository)
#   OT_INSTALL_CHANNEL    stable (default) or beta
#   OT_INSTALL_SERVICE    auto (default) or off: whether to register the logon service
#   OT_INSTALL_OPENSSL    the openssl to check the signature with (default: the one in the PATH)
#   OT_INSTALL_PUBLIC_KEY_FILE  a public key (PEM) to check the manifest with, instead of the one
#                         this script carries; only for tests and mirrors, and it prints a warning
#
# Exit codes: 0 done; 1 failed (network, system not supported, the executable does not run); 2 wrong
# use; 3 the release did not check (signature, SHA-256, size or channel): nothing was installed;
# 4 installed, but the service step failed.
#
# The whole script is a set of functions and the last line calls `main`, so a download that is cut
# in the middle (`curl ... | sh`) runs nothing.

# BEGIN embedded public key
# The release job (P9) replaces the next line with the PEM text of tools/release/keys/update-public-key.pem
# (the same key the executable embeds). Until the owner makes the key (N246) it is the word PLACEHOLDER,
# and the signature is then checked only by the executable (see check_signature).
EMBEDDED_PUBLIC_KEY='PLACEHOLDER'
# END embedded public key

REPOSITORY='asantos43/orchestration-theater'
EXIT_FAILED=1
EXIT_USAGE=2
EXIT_UNVERIFIED=3
EXIT_SERVICE=4
MAX_MANIFEST_BYTES=262144
MAX_SIGNATURE_BYTES=4096
MAX_EXE_BYTES=1073741824
MAX_NOTICES_BYTES=4194304

STAGE=''
BIN_DIR=''
APP_DIR=''

# ---------------------------------------------------------------------------------------------
# Messages, in English and Brazilian Portuguese (by LC_ALL, LC_MESSAGES or LANG).

case "${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}" in
  pt*) LANG_ID=pt ;;
  *) LANG_ID=en ;;
esac

fmt() {
  if [ "$LANG_ID" = pt ]; then
    case $1 in
      usage) echo 'Uso: sh install.sh [--uninstall [--purge-data] [--yes]] [--help]' ;;
      bad_arg) echo 'argumento desconhecido: %s' ;;
      purge_needs_uninstall) echo '--purge-data só vale com --uninstall' ;;
      no_home) echo 'HOME não está definido como uma pasta absoluta' ;;
      is_root) echo 'não rode como root: a instalação é por usuário e não usa sudo' ;;
      bad_channel) echo 'OT_INSTALL_CHANNEL=%s: use stable ou beta' ;;
      bad_service) echo 'OT_INSTALL_SERVICE=%s: use auto ou off' ;;
      bad_base) echo 'OT_INSTALL_BASE_URL=%s: use https:// (ou http:// só no loopback), sem usuário e senha' ;;
      unsupported) echo 'sistema não suportado: %s %s (a v1 tem linux-x64 e darwin-arm64)' ;;
      no_downloader) echo 'preciso de curl ou wget para baixar' ;;
      no_hasher) echo 'preciso de sha256sum ou shasum para conferir o SHA-256' ;;
      downloading) echo 'Baixando %s' ;;
      download_failed) echo 'falha ao baixar %s' ;;
      too_big) echo 'o arquivo %s é maior do que o permitido' ;;
      list_failed) echo 'não achei uma pré-versão (beta) publicada' ;;
      key_env_warn) echo 'AVISO: conferindo com a chave pública de OT_INSTALL_PUBLIC_KEY_FILE, e não com a deste script' ;;
      sig_bad) echo 'RECUSADO: a assinatura do manifesto não confere. Nada foi instalado.' ;;
      sig_exe_warn) echo 'AVISO: este sistema não tem um openssl que confira Ed25519 (ou o script não leva a chave pública). A assinatura foi conferida pelo próprio executável baixado, com a chave embutida nele: isso confia no que acabou de ser baixado.' ;;
      sig_exe_unavailable) echo 'RECUSADO: a assinatura não pôde ser conferida (sem openssl com Ed25519, e o executável rejeitou o manifesto ou não tem o modo verify-release). Nada foi instalado.' ;;
      sig_ok) echo 'Assinatura do manifesto conferida (Ed25519).' ;;
      manifest_bad) echo 'RECUSADO: o manifesto não tem o que o instalador precisa (%s). Nada foi instalado.' ;;
      channel_mismatch) echo 'RECUSADO: o manifesto é do canal %s, e foi pedido %s. Nada foi instalado.' ;;
      hash_bad) echo 'RECUSADO: o SHA-256 ou o tamanho de %s não confere com o manifesto. Nada foi instalado.' ;;
      exe_wont_run) echo 'o executável baixado não roda neste sistema. Nada foi instalado.' ;;
      hash_ok) echo 'SHA-256 conferido: %s' ;;
      installed_exe) echo 'Instalado: %s (versão %s)' ;;
      installed_notices) echo 'Avisos de licenças de terceiros: %s' ;;
      link_ok) echo 'Atalho: %s' ;;
      link_foreign) echo 'AVISO: %s já existe e não é deste instalador; não mexi nele. Rode o ot por %s.' ;;
      service_off) echo 'Serviço de logon: não registrado (OT_INSTALL_SERVICE=off).' ;;
      service_failed) echo 'AVISO: o serviço de logon não foi registrado. Rode "%s service install" depois de ver o motivo acima.' ;;
      done_title) echo 'Pronto. O que falta:' ;;
      todo_path) echo "  - %s não está no PATH. Acrescente ao perfil do seu shell: export PATH=\"%s:\$PATH\"" ;;
      todo_acp) echo '  - adaptador ACP não encontrado no PATH: %s (a v1 não os leva; veja a documentação)' ;;
      todo_client) echo '  - cliente não encontrado no PATH: %s (instale o que você usa)' ;;
      todo_none) echo '  nada.' ;;
      todo_restart) echo '  - havia uma versão instalada; um daemon que já estava no ar só passa à nova depois de "ot service stop" e "ot service start".' ;;
      data_kept) echo 'Os dados (store, telemetria, backups, configuração) ficam em %s.' ;;
      uninstall_nothing) echo 'Não há instalação em %s.' ;;
      uninstall_service_failed) echo 'AVISO: "ot uninstall" falhou; se o serviço ficou registrado, rode "ot service uninstall" à mão ou remova a definição dele.' ;;
      removed) echo 'Removido: %s' ;;
      uninstalled) echo 'Desinstalado. Os dados foram preservados em %s.' ;;
      purge_confirm) echo 'Apagar TODOS os dados em %s? Isso não tem volta. [s/N] ' ;;
      purge_need_yes) echo 'sem terminal para perguntar: confirme com --yes' ;;
      purge_cancelled) echo 'Cancelado: nada foi apagado.' ;;
      purge_refused) echo 'AVISO: %s não parece uma pasta de dados do OTheater (sem config.yaml, store.sqlite nem daemon-id), ou é a raiz ou o HOME: não apaguei.' ;;
      purged) echo 'Dados apagados: %s' ;;
      keyring_note) echo 'As credenciais guardadas no chaveiro do sistema não são tocadas.' ;;
      *) echo "$1" ;;
    esac
  else
    case $1 in
      usage) echo 'Usage: sh install.sh [--uninstall [--purge-data] [--yes]] [--help]' ;;
      bad_arg) echo 'unknown argument: %s' ;;
      purge_needs_uninstall) echo '--purge-data only works with --uninstall' ;;
      no_home) echo 'HOME is not set to an absolute folder' ;;
      is_root) echo 'do not run as root: the install is per user and uses no sudo' ;;
      bad_channel) echo 'OT_INSTALL_CHANNEL=%s: use stable or beta' ;;
      bad_service) echo 'OT_INSTALL_SERVICE=%s: use auto or off' ;;
      bad_base) echo 'OT_INSTALL_BASE_URL=%s: use https:// (or http:// on the loopback only), with no user and password' ;;
      unsupported) echo 'system not supported: %s %s (v1 has linux-x64 and darwin-arm64)' ;;
      no_downloader) echo 'curl or wget is needed to download' ;;
      no_hasher) echo 'sha256sum or shasum is needed to check the SHA-256' ;;
      downloading) echo 'Downloading %s' ;;
      download_failed) echo 'could not download %s' ;;
      too_big) echo 'the file %s is bigger than allowed' ;;
      list_failed) echo 'no published prerelease (beta) was found' ;;
      key_env_warn) echo 'WARNING: checking with the public key of OT_INSTALL_PUBLIC_KEY_FILE, not the one of this script' ;;
      sig_bad) echo 'REFUSED: the signature of the manifest does not check. Nothing was installed.' ;;
      sig_exe_warn) echo 'WARNING: this system has no openssl that checks Ed25519 (or the script carries no public key). The signature was checked by the downloaded executable itself, with the key built into it: that trusts what was just downloaded.' ;;
      sig_exe_unavailable) echo 'REFUSED: the signature could not be checked (no openssl with Ed25519, and the executable rejected the manifest or has no verify-release mode). Nothing was installed.' ;;
      sig_ok) echo 'Signature of the manifest checked (Ed25519).' ;;
      manifest_bad) echo 'REFUSED: the manifest lacks what the installer needs (%s). Nothing was installed.' ;;
      channel_mismatch) echo 'REFUSED: the manifest is of the %s channel, and %s was asked. Nothing was installed.' ;;
      hash_bad) echo 'REFUSED: the SHA-256 or the size of %s does not match the manifest. Nothing was installed.' ;;
      exe_wont_run) echo 'the downloaded executable does not run on this system. Nothing was installed.' ;;
      hash_ok) echo 'SHA-256 checked: %s' ;;
      installed_exe) echo 'Installed: %s (version %s)' ;;
      installed_notices) echo 'Third-party license notices: %s' ;;
      link_ok) echo 'Shortcut: %s' ;;
      link_foreign) echo 'WARNING: %s already exists and is not from this installer; I left it alone. Run ot as %s.' ;;
      service_off) echo 'Logon service: not registered (OT_INSTALL_SERVICE=off).' ;;
      service_failed) echo 'WARNING: the logon service was not registered. Run "%s service install" after you see why above.' ;;
      done_title) echo 'Done. What is left:' ;;
      todo_path) echo "  - %s is not in the PATH. Add to your shell profile: export PATH=\"%s:\$PATH\"" ;;
      todo_acp) echo '  - ACP adapter not found in the PATH: %s (v1 does not ship them; see the documentation)' ;;
      todo_client) echo '  - client not found in the PATH: %s (install the ones you use)' ;;
      todo_none) echo '  nothing.' ;;
      todo_restart) echo '  - a version was already installed; a daemon that was running only moves to the new one after "ot service stop" and "ot service start".' ;;
      data_kept) echo 'The data (store, telemetry, backups, configuration) stays in %s.' ;;
      uninstall_nothing) echo 'There is no install in %s.' ;;
      uninstall_service_failed) echo 'WARNING: "ot uninstall" failed; if the service stayed registered, run "ot service uninstall" by hand or remove its definition.' ;;
      removed) echo 'Removed: %s' ;;
      uninstalled) echo 'Uninstalled. The data was kept in %s.' ;;
      purge_confirm) echo 'Delete ALL the data in %s? This cannot be undone. [y/N] ' ;;
      purge_need_yes) echo 'no terminal to ask on: confirm with --yes' ;;
      purge_cancelled) echo 'Cancelled: nothing was deleted.' ;;
      purge_refused) echo 'WARNING: %s does not look like an OTheater data folder (no config.yaml, store.sqlite or daemon-id), or it is the root or the HOME: I did not delete it.' ;;
      purged) echo 'Data deleted: %s' ;;
      keyring_note) echo 'The credentials kept in the system keyring are not touched.' ;;
      *) echo "$1" ;;
    esac
  fi
}

# say KEY [ARGS...]: a message to stdout. warn: to stderr. die CODE KEY [ARGS...]: warn and exit.
say() {
  say_key=$1
  shift
  # shellcheck disable=SC2059 # the format is one of ours, from fmt
  printf -- "$(fmt "$say_key")\n" "$@"
}

warn() {
  warn_key=$1
  shift
  # shellcheck disable=SC2059 # the format is one of ours, from fmt
  printf -- "$(fmt "$warn_key")\n" "$@" >&2
}

die() {
  die_code=$1
  shift
  warn "$@"
  exit "$die_code"
}

# ---------------------------------------------------------------------------------------------
# Cleanup: the staging folder is inside the install folder (same file system, so the final move
# is one rename, and nothing is written outside HOME).

cleanup() {
  if [ -n "$STAGE" ] && [ -d "$STAGE" ]; then rm -rf "$STAGE"; fi
  # Removes the folders this run created when nothing was installed (rmdir only removes empty ones).
  if [ -n "$BIN_DIR" ]; then rmdir "$BIN_DIR" 2>/dev/null || true; fi
  if [ -n "$APP_DIR" ]; then rmdir "$APP_DIR" 2>/dev/null || true; fi
}

# ---------------------------------------------------------------------------------------------
# Platform and places.

# detect_platform OS ARCH: prints the platform id of the release files, or nothing.
detect_platform() {
  case "$1:$2" in
    Linux:x86_64 | Linux:amd64) echo linux-x64 ;;
    Darwin:arm64 | Darwin:aarch64) echo darwin-arm64 ;;
    *) ;;
  esac
}

# data_dir_of OS: the data folder of the daemon (docs: paths.ts), or OT_DATA_DIR.
data_dir_of() {
  if [ -n "${OT_DATA_DIR:-}" ]; then
    echo "$OT_DATA_DIR"
  elif [ "$1" = Darwin ]; then
    echo "$HOME/Library/Application Support/OTheater"
  else
    case ${XDG_DATA_HOME:-} in
      /*) echo "$XDG_DATA_HOME/otheater" ;;
      *) echo "$HOME/.local/share/otheater" ;;
    esac
  fi
}

# app_dir_of OS: ~/.local/share/otheater (the XDG data folder on Linux). The executable goes in
# its bin/ folder [proposta]: on Linux this is the data folder of the daemon too, so the two stay
# apart by a subfolder, and `--purge-data` (which deletes the data folder) takes the install with it.
app_dir_of() {
  if [ "$1" = Linux ]; then
    case ${XDG_DATA_HOME:-} in
      /*) echo "$XDG_DATA_HOME/otheater" ;;
      *) echo "$HOME/.local/share/otheater" ;;
    esac
  else
    echo "$HOME/.local/share/otheater"
  fi
}

# ---------------------------------------------------------------------------------------------
# Network.

# check_base BASE: refuses an address that is not https (or http on the loopback) or that carries
# a user and a password; prints the scheme.
check_base() {
  case $1 in
    https://*) cb_scheme=https ;;
    http://127.0.0.1 | http://127.0.0.1[:/]* | http://localhost | http://localhost[:/]* | 'http://[::1]' | 'http://[::1]'[:/]*)
      cb_scheme=http ;;
    *) return 1 ;;
  esac
  cb_authority=${1#*://}
  cb_authority=${cb_authority%%/*}
  case $cb_authority in
    *@* | '') return 1 ;;
  esac
  echo "$cb_scheme"
}

# fetch URL DEST MAXBYTES TIMEOUT: one file, https (or the http of the loopback), redirects only to
# https, no credentials, a size cap. The caller checks what it got.
fetch() {
  fetch_url=$1
  fetch_dest=$2
  fetch_max=$3
  fetch_timeout=$4
  if command -v curl >/dev/null 2>&1; then
    # -q first: no .curlrc. --proto-redir: a redirect never goes to plain http.
    curl -q --fail --silent --show-error --location --proto "=$BASE_SCHEME" --proto-redir =https \
      --max-redirs 5 --connect-timeout 20 --max-time "$fetch_timeout" --max-filesize "$fetch_max" \
      --user-agent otheater-install-sh --output "$fetch_dest" "$fetch_url"
    fetch_rc=$?
    # 63: more bytes than the manifest says (--max-filesize), which is a mismatch, not a network failure.
    if [ "$fetch_rc" = 63 ]; then return 2; fi
    [ "$fetch_rc" = 0 ] || return 1
  elif command -v wget >/dev/null 2>&1; then
    if [ "$BASE_SCHEME" = https ]; then fetch_https=--https-only; else fetch_https=''; fi
    # shellcheck disable=SC2086 # the empty option must vanish
    wget -q $fetch_https --max-redirect=5 --tries=1 --timeout=30 --user-agent=otheater-install-sh \
      -O "$fetch_dest" "$fetch_url" || return 1
  else
    return 1
  fi
  fetch_size=$(file_size "$fetch_dest")
  [ "$fetch_size" -le "$fetch_max" ] || return 2
  return 0
}

file_size() {
  wc -c <"$1" | tr -d ' \t'
}

# download NAME URL DEST MAXBYTES TIMEOUT: fetch with the messages and the exit.
download() {
  say downloading "$1"
  fetch "$2" "$3" "$4" "$5"
  download_rc=$?
  case $download_rc in
    0) ;;
    2) die "$EXIT_UNVERIFIED" too_big "$1" ;;
    *) die "$EXIT_FAILED" download_failed "$1" ;;
  esac
}

# latest_prerelease_tag: reads the list of releases (JSON of the GitHub API) on stdin and prints the
# tag of the first one that is a prerelease and not a draft. [N] The keys of one release are read
# in the order GitHub writes them (tag_name before draft and prerelease).
latest_prerelease_tag() {
  # shellcheck disable=SC2020 # three different characters, each one to a newline, on purpose
  tr ',{}' '\n\n\n' | awk '
    /"tag_name"[ \t]*:/ { tag = $0; sub(/.*"tag_name"[ \t]*:[ \t]*"/, "", tag); sub(/".*/, "", tag); draft = ""; pre = "" }
    /"draft"[ \t]*:/ { draft = ($0 ~ /true/) ? "true" : "false" }
    /"prerelease"[ \t]*:/ { pre = ($0 ~ /true/) ? "true" : "false" }
    tag != "" && draft == "false" && pre == "true" { print tag; exit }
  '
}

# ---------------------------------------------------------------------------------------------
# Manifest (the JSON of docs/21, "Formato dos artefatos e da assinatura"). It is read only by
# patterns, because a POSIX shell has no JSON; the file is read AFTER its signature checked, except
# for the name of the executable when the signature is checked by that executable (see
# check_signature), and every value is checked against a strict pattern before it is used.

manifest_flat() {
  tr -d '\r\n' <"$1"
}

# manifest_top KEY FILE: a top-level string of the manifest (the assets list is cut out first).
manifest_top() {
  manifest_flat "$2" | sed 's/"assets"[[:space:]]*:[[:space:]]*\[[^]]*\]//' |
    sed -n 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1
}

# manifest_asset_records FILE: one line per asset object.
manifest_asset_records() {
  manifest_flat "$1" | sed -n 's/.*"assets"[[:space:]]*:[[:space:]]*\[\([^]]*\)\].*/\1/p' | tr '}' '\n'
}

json_str() {
  printf '%s' "$2" | sed -n 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p'
}

json_num() {
  printf '%s' "$2" | sed -n 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p'
}

# find_asset FILE PLATFORM KIND NAME: prints "name size sha256" of the asset that matches the
# platform and the kind (NAME empty), or the one with that exact name (KIND and PLATFORM empty).
find_asset() {
  manifest_asset_records "$1" | while IFS= read -r fa_record; do
    [ -n "$fa_record" ] || continue
    fa_name=$(json_str name "$fa_record")
    if [ -n "$4" ]; then
      [ "$fa_name" = "$4" ] || continue
    else
      [ "$(json_str platform "$fa_record")" = "$2" ] || continue
      [ "$(json_str kind "$fa_record")" = "$3" ] || continue
    fi
    echo "$fa_name $(json_num size "$fa_record") $(json_str sha256 "$fa_record")"
    break
  done
}

# valid_asset NAME SIZE SHA MAX: the strict patterns of the manifest schema of P7.
valid_asset() {
  printf '%s' "$1" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' || return 1
  printf '%s' "$3" | grep -Eq '^[0-9a-f]{64}$' || return 1
  printf '%s' "$2" | grep -Eq '^[1-9][0-9]{0,9}$' || return 1
  [ "$2" -le "$4" ] || return 1
}

# ---------------------------------------------------------------------------------------------
# SHA-256 and the Ed25519 signature.

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    return 1
  fi
}

# check_file FILE SIZE SHA: the size and the SHA-256 the manifest says.
check_file() {
  [ "$(file_size "$1")" = "$2" ] || return 1
  cf_hash=$(sha256_of "$1") || return 1
  [ "$cf_hash" = "$3" ]
}

# openssl_check KEYFILE MANIFEST SIGFILE: 0 checks, 1 does not check, 2 no openssl that can.
# `openssl pkeyutl -rawin` exists from OpenSSL 3.0; the LibreSSL of macOS does not have it [N].
openssl_check() {
  oc_ossl=${OT_INSTALL_OPENSSL:-openssl}
  command -v "$oc_ossl" >/dev/null 2>&1 || return 2
  "$oc_ossl" pkeyutl -help 2>&1 | grep -q 'rawin' || return 2
  # The signature: base64 of 64 bytes, on one line.
  oc_b64=$(tr -d ' \t\r\n' <"$3")
  printf '%s' "$oc_b64" | grep -Eq '^[A-Za-z0-9+/]{86}==$' || return 1
  printf '%s' "$oc_b64" | "$oc_ossl" base64 -d -A >"$STAGE/signature.bin" 2>/dev/null || return 1
  [ "$(file_size "$STAGE/signature.bin")" = 64 ] || return 1
  "$oc_ossl" pkeyutl -verify -pubin -inkey "$1" -rawin -in "$2" -sigfile "$STAGE/signature.bin" \
    >/dev/null 2>&1
}

# ---------------------------------------------------------------------------------------------
# Install.

do_install() {
  UNAME_S=$(uname -s)
  UNAME_M=$(uname -m)
  PLATFORM=$(detect_platform "$UNAME_S" "$UNAME_M")
  [ -n "$PLATFORM" ] || die "$EXIT_FAILED" unsupported "$UNAME_S" "$UNAME_M"
  command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1 || die "$EXIT_FAILED" no_downloader
  sha256_of /dev/null >/dev/null 2>&1 || die "$EXIT_FAILED" no_hasher

  APP_DIR=$(app_dir_of "$UNAME_S")
  BIN_DIR="$APP_DIR/bin"
  EXE="$BIN_DIR/otheater"
  LINK_DIR="$HOME/.local/bin"
  LINK="$LINK_DIR/ot"
  had_previous=0
  [ -x "$EXE" ] && had_previous=1

  # Where the release is. A base given by the variable serves the channel as it is (the manifest says
  # which channel it is, and it is checked below); the default asks GitHub.
  if [ -n "${OT_INSTALL_BASE_URL:-}" ]; then
    BASE=${OT_INSTALL_BASE_URL%/}
    BASE_SCHEME=$(check_base "$BASE") || die "$EXIT_USAGE" bad_base "$OT_INSTALL_BASE_URL"
  else
    BASE=''
    BASE_SCHEME=https
  fi

  mkdir -p "$BIN_DIR"
  chmod 700 "$APP_DIR" 2>/dev/null || true
  STAGE=$(mktemp -d "$BIN_DIR/.install.XXXXXX") || die "$EXIT_FAILED" download_failed staging
  chmod 700 "$STAGE"

  if [ -z "$BASE" ]; then
    if [ "$CHANNEL" = stable ]; then
      BASE="https://github.com/$REPOSITORY/releases/latest/download"
    else
      # The beta channel: the first prerelease of the list (one small request more than the three files).
      download 'the list of releases' "https://api.github.com/repos/$REPOSITORY/releases?per_page=30" \
        "$STAGE/releases.json" 2097152 60
      tag=$(latest_prerelease_tag <"$STAGE/releases.json")
      printf '%s' "$tag" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' || die "$EXIT_FAILED" list_failed
      BASE="https://github.com/$REPOSITORY/releases/download/$tag"
      rm -f "$STAGE/releases.json"
    fi
  fi

  MANIFEST="$STAGE/manifest.json"
  SIGFILE="$STAGE/manifest.json.sig"
  download manifest.json "$BASE/manifest.json" "$MANIFEST" "$MAX_MANIFEST_BYTES" 60
  download manifest.json.sig "$BASE/manifest.json.sig" "$SIGFILE" "$MAX_SIGNATURE_BYTES" 60

  # 1. The signature, with openssl when there is a key to check with and an openssl that can.
  KEYFILE=''
  if [ -n "${OT_INSTALL_PUBLIC_KEY_FILE:-}" ]; then
    warn key_env_warn
    KEYFILE=$OT_INSTALL_PUBLIC_KEY_FILE
  else
    case $EMBEDDED_PUBLIC_KEY in
      '-----BEGIN PUBLIC KEY-----'*)
        printf '%s\n' "$EMBEDDED_PUBLIC_KEY" >"$STAGE/key.pem"
        KEYFILE="$STAGE/key.pem"
        ;;
      *) ;;
    esac
  fi
  SIG_BY_EXE=1
  if [ -n "$KEYFILE" ]; then
    openssl_check "$KEYFILE" "$MANIFEST" "$SIGFILE"
    case $? in
      0) SIG_BY_EXE=0 ;;
      1) die "$EXIT_UNVERIFIED" sig_bad ;;
      *) ;;
    esac
  fi

  # 2. What the manifest says.
  version=$(manifest_top version "$MANIFEST")
  channel=$(manifest_top channel "$MANIFEST")
  printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.+-]*)?$' ||
    die "$EXIT_UNVERIFIED" manifest_bad version
  [ "$channel" = "$CHANNEL" ] || die "$EXIT_UNVERIFIED" channel_mismatch "${channel:-?}" "$CHANNEL"
  asset=$(find_asset "$MANIFEST" "$PLATFORM" exe '')
  [ -n "$asset" ] || die "$EXIT_UNVERIFIED" manifest_bad "$PLATFORM"
  # shellcheck disable=SC2086 # three words, split on purpose
  set -- $asset
  asset_name=$1
  asset_size=$2
  asset_sha=${3:-}
  valid_asset "$asset_name" "$asset_size" "$asset_sha" "$MAX_EXE_BYTES" || die "$EXIT_UNVERIFIED" manifest_bad "$PLATFORM"

  # 3. The executable: the size and the SHA-256 of the manifest.
  download "$asset_name" "$BASE/$asset_name" "$STAGE/otheater" "$asset_size" 1800
  check_file "$STAGE/otheater" "$asset_size" "$asset_sha" || die "$EXIT_UNVERIFIED" hash_bad "$asset_name"
  chmod 755 "$STAGE/otheater"

  # 4. The signature by the executable, when openssl could not do it. [N253] The executable is the
  # thing that was just downloaded, and the manifest it checks gives the hash that it matches, so this
  # only proves that the executable and the manifest agree on the key: the warning says it.
  if [ "$SIG_BY_EXE" = 1 ]; then
    warn sig_exe_warn
    "$STAGE/otheater" --ot-internal=verify-release "$MANIFEST" "$SIGFILE" >/dev/null 2>&1 ||
      die "$EXIT_UNVERIFIED" sig_exe_unavailable
  else
    say sig_ok
  fi
  say hash_ok "$asset_sha"

  # 5. The notices of the licenses of this platform, when the release has them [proposta, P10]: one
  # more file of the manifest, checked like the executable.
  notices_name="THIRD_PARTY_NOTICES-$PLATFORM.md"
  have_notices=0
  notice=$(find_asset "$MANIFEST" '' '' "$notices_name")
  if [ -n "$notice" ]; then
    # shellcheck disable=SC2086
    set -- $notice
    if valid_asset "$1" "$2" "${3:-}" "$MAX_NOTICES_BYTES"; then
      download "$1" "$BASE/$1" "$STAGE/notices.md" "$2" 300
      check_file "$STAGE/notices.md" "$2" "$3" || die "$EXIT_UNVERIFIED" hash_bad "$1"
      have_notices=1
    fi
  fi

  # 6. It has to run here, and say its version.
  installed_version=$("$STAGE/otheater" --version 2>/dev/null | head -n 1) || installed_version=''
  [ -n "$installed_version" ] || die "$EXIT_FAILED" exe_wont_run

  # 7. Install: one rename over the old file. A daemon from a previous install is asked to stop first.
  if [ "$had_previous" = 1 ] && [ "$SERVICE" = auto ]; then
    "$EXE" service stop >/dev/null 2>&1 || true
  fi
  mv -f "$STAGE/otheater" "$EXE"
  say installed_exe "$EXE" "$version"
  if [ "$have_notices" = 1 ]; then
    mv -f "$STAGE/notices.md" "$APP_DIR/THIRD_PARTY_NOTICES.md"
    say installed_notices "$APP_DIR/THIRD_PARTY_NOTICES.md"
  fi
  rm -rf "$STAGE"
  STAGE=''

  # 8. The shortcut `ot`: only where nothing else is.
  link_note=0
  mkdir -p "$LINK_DIR"
  if [ ! -e "$LINK" ] && [ ! -L "$LINK" ]; then
    ln -s "$EXE" "$LINK"
    say link_ok "$LINK"
  elif [ -L "$LINK" ] && [ "$(readlink "$LINK")" = "$EXE" ]; then
    say link_ok "$LINK"
  else
    warn link_foreign "$LINK" "$EXE"
    link_note=1
  fi

  # 9. The logon service (P3).
  service_rc=0
  if [ "$SERVICE" = off ]; then
    say service_off
  else
    "$EXE" service install || service_rc=$?
    [ "$service_rc" = 0 ] || warn service_failed "$EXE"
  fi

  # 10. What is left.
  say done_title
  todo=0
  if [ "$link_note" = 0 ]; then
    case ":$PATH:" in
      *":$LINK_DIR:"*) ;;
      *)
        say todo_path "$LINK_DIR" "$LINK_DIR"
        todo=1
        ;;
    esac
  fi
  for adapter in claude-agent-acp codex-acp; do
    if ! command -v "$adapter" >/dev/null 2>&1; then
      say todo_acp "$adapter"
      todo=1
    fi
  done
  for client in claude codex opencode; do
    if ! command -v "$client" >/dev/null 2>&1; then
      say todo_client "$client"
      todo=1
    fi
  done
  if [ "$had_previous" = 1 ] && [ "$SERVICE" = auto ]; then
    say todo_restart
    todo=1
  fi
  [ "$todo" = 1 ] || say todo_none
  say data_kept "$(data_dir_of "$UNAME_S")"
  if [ "$service_rc" != 0 ]; then return "$EXIT_SERVICE"; fi
  return 0
}

# ---------------------------------------------------------------------------------------------
# Uninstall.

# purge_refusal DIR: succeeds (prints nothing) when DIR may be deleted as a data folder, the same
# rules as `ot uninstall --purge-data` [proposta]: not the root, not the HOME nor a folder above it,
# and it holds one of config.yaml, store.sqlite or daemon-id.
may_purge() {
  case $1 in
    /*) ;;
    *) return 1 ;;
  esac
  case $1 in
    */.. | */../* | */. | */./*) return 1 ;;
  esac
  mp_dir=$1
  while [ "$mp_dir" != / ] && [ "${mp_dir%/}" != "$mp_dir" ]; do mp_dir=${mp_dir%/}; done
  [ -n "$mp_dir" ] && [ "$mp_dir" != / ] || return 1
  case "${HOME%/}/" in
    "$mp_dir"/*) return 1 ;;
  esac
  [ -d "$mp_dir" ] || return 1
  [ -e "$mp_dir/config.yaml" ] || [ -e "$mp_dir/store.sqlite" ] || [ -e "$mp_dir/daemon-id" ]
}

# confirm_purge QUESTION: yes with --yes; otherwise asks on the terminal (also when the script comes
# from a pipe), and with no terminal it refuses.
confirm_purge() {
  [ "$YES" = 1 ] && return 0
  if [ -t 0 ]; then
    # shellcheck disable=SC2059 # the format is one of ours, from fmt
    printf "$(fmt purge_confirm)" "$1" >&2
    read -r cp_answer || cp_answer=''
  elif (: </dev/tty) 2>/dev/null; then
    # shellcheck disable=SC2059 # the format is one of ours, from fmt
    printf "$(fmt purge_confirm)" "$1" >&2
    read -r cp_answer </dev/tty || cp_answer=''
  else
    warn purge_need_yes
    exit "$EXIT_USAGE"
  fi
  case $cp_answer in
    y | Y | yes | YES | s | S | sim | SIM) return 0 ;;
    *)
      say purge_cancelled
      exit "$EXIT_FAILED"
      ;;
  esac
}

do_uninstall() {
  UNAME_S=$(uname -s)
  APP_DIR=$(app_dir_of "$UNAME_S")
  BIN_DIR="$APP_DIR/bin"
  EXE="$BIN_DIR/otheater"
  LINK="$HOME/.local/bin/ot"
  DATA_DIR=$(data_dir_of "$UNAME_S")
  service_rc=0

  if [ "$PURGE" = 1 ]; then confirm_purge "$DATA_DIR"; fi

  found=0
  if [ -x "$EXE" ] || [ -e "$APP_DIR/THIRD_PARTY_NOTICES.md" ] || [ -L "$LINK" ]; then found=1; fi
  [ "$found" = 1 ] || say uninstall_nothing "$APP_DIR"

  # The service first: `ot uninstall` stops the daemon and removes the definition, and keeps the data.
  if [ -x "$EXE" ] && [ "$SERVICE" = auto ]; then
    "$EXE" uninstall || service_rc=$?
    [ "$service_rc" = 0 ] || warn uninstall_service_failed
  fi

  if [ -L "$LINK" ] && [ "$(readlink "$LINK")" = "$EXE" ]; then
    rm -f "$LINK"
    say removed "$LINK"
  fi
  if [ -e "$EXE" ] || [ -L "$EXE" ]; then
    rm -f "$EXE"
    say removed "$EXE"
  fi
  if [ -e "$APP_DIR/THIRD_PARTY_NOTICES.md" ]; then
    rm -f "$APP_DIR/THIRD_PARTY_NOTICES.md"
    say removed "$APP_DIR/THIRD_PARTY_NOTICES.md"
  fi
  rm -rf "$BIN_DIR"/.install.* 2>/dev/null || true
  rmdir "$BIN_DIR" 2>/dev/null || true
  rmdir "$APP_DIR" 2>/dev/null || true

  if [ "$PURGE" = 1 ]; then
    if may_purge "$DATA_DIR"; then
      rm -rf "$DATA_DIR"
      say purged "$DATA_DIR"
    else
      warn purge_refused "$DATA_DIR"
    fi
    say keyring_note
  else
    say uninstalled "$DATA_DIR"
  fi
  if [ "$service_rc" != 0 ]; then return "$EXIT_SERVICE"; fi
  return 0
}

# ---------------------------------------------------------------------------------------------

main() {
  UNINSTALL=0
  PURGE=0
  YES=0
  for arg in "$@"; do
    case $arg in
      --uninstall) UNINSTALL=1 ;;
      --purge-data) PURGE=1 ;;
      --yes | -y) YES=1 ;;
      --help | -h)
        say usage
        return 0
        ;;
      *) die "$EXIT_USAGE" bad_arg "$arg" ;;
    esac
  done
  if [ "$PURGE" = 1 ] && [ "$UNINSTALL" = 0 ]; then die "$EXIT_USAGE" purge_needs_uninstall; fi

  CHANNEL=${OT_INSTALL_CHANNEL:-stable}
  case $CHANNEL in
    stable | beta) ;;
    *) die "$EXIT_USAGE" bad_channel "$CHANNEL" ;;
  esac
  SERVICE=${OT_INSTALL_SERVICE:-auto}
  case $SERVICE in
    auto | off) ;;
    *) die "$EXIT_USAGE" bad_service "$SERVICE" ;;
  esac
  case ${HOME:-} in
    /?*) ;;
    *) die "$EXIT_USAGE" no_home ;;
  esac
  [ "$(id -u)" != 0 ] || die "$EXIT_USAGE" is_root

  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  umask 022

  if [ "$UNINSTALL" = 1 ]; then
    do_uninstall
  else
    do_install
  fi
}

# OT_INSTALL_LIB=1 only defines the functions (the tests load the script this way).
if [ "${OT_INSTALL_LIB:-}" != 1 ]; then
  main "$@"
fi
