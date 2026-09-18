#!/usr/bin/env bash
#
# Passos do deploy da API, versionados no repo em vez de embutidos no YAML.
#
# O appleboy/ssh-action corrompe scripts multi-linha ao transporta-los pela sessao SSH
# (blocos { ...; } e case/;; viram "syntax error near ;"). Um arquivo committed, lido
# por um bash de verdade na VM, escapa disso por completo -- e ainda pode ser testado
# com `bash -n` antes de subir.
#
# Config nao-secreta chega pelo ambiente (bloco `env:` do workflow); segredos chegam
# pelo `envs:` do ssh-action. Nada e interpolado no texto: os valores vem de variaveis,
# entao uma senha com $ ou aspas entra literal.
#
# Uso: deploy.sh {check-secrets | write-env | up | wait-health | all}

set -euo pipefail

# Roda sempre a partir de backend/, seja qual for o diretorio de onde foi chamado:
# .env e docker-compose.yml sao relativos a ele.
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
cd "$SCRIPT_DIR/.."

# Padroes para os campos nao-secretos, para o script tambem rodar a mao numa emergencia.
API_PORT="${API_PORT:-3009}"
HOST_PORT="${HOST_PORT:-3012}"
POSTGRES_USER="${POSTGRES_USER:-spendr_user}"
POSTGRES_DB="${POSTGRES_DB:-spendr_db}"
ACCESS_TOKEN_TTL="${ACCESS_TOKEN_TTL:-15m}"
REFRESH_TOKEN_DAYS="${REFRESH_TOKEN_DAYS:-30}"
SYNC_PAGE_SIZE="${SYNC_PAGE_SIZE:-500}"
CORS_ORIGINS="${CORS_ORIGINS:-}"

# ---------------------------------------------------------------------------

# Lista de permitidos, nao de proibidos. A senha e o segredo atravessam tres parsers com
# regras diferentes -- o do .env, o do docker compose (que expande $VAR) e o de URL do
# Postgres (onde @ : / ? # tem significado). Aceitar so [A-Za-z0-9_.~-], os caracteres
# "unreserved" de URI, e seguro nos tres.
validar_segredo() {
  nome="$1"
  valor="$2"

  if [ -z "$valor" ]; then
    echo "ERRO: $nome nao esta definido (secret ausente no GitHub?)"
    exit 1
  fi

  case "$valor" in
    *[!A-Za-z0-9_.~-]*)
      echo "ERRO: $nome tem caractere fora de [A-Za-z0-9_.~-]."
      echo "      Gere um valor seguro com:"
      echo "      node -e \"console.log(require('crypto').randomBytes(64).toString('base64').replace(/[^A-Za-z0-9]/g,'').slice(0,48))\""
      exit 1
      ;;
  esac

  if [ "${#valor}" -lt 16 ]; then
    echo "ERRO: $nome tem menos de 16 caracteres"
    exit 1
  fi
}

cmd_check_secrets() {
  echo "==> Validando segredos"
  validar_segredo POSTGRES_PASSWORD "${POSTGRES_PASSWORD:-}"
  validar_segredo JWT_SECRET "${JWT_SECRET:-}"
  echo "Segredos OK"
}

cmd_write_env() {
  echo "==> Escrevendo .env"
  # umask antes de criar: nasce 600, sem janela em que outro usuario da VM o leia.
  umask 077
  {
    printf 'NODE_ENV=production\n'
    printf 'PORT=%s\n'               "$API_PORT"
    printf 'POSTGRES_USER=%s\n'      "$POSTGRES_USER"
    printf 'POSTGRES_PASSWORD=%s\n'  "$POSTGRES_PASSWORD"
    printf 'POSTGRES_DB=%s\n'        "$POSTGRES_DB"
    # Derivado das partes, e nao um segredo proprio: impossivel trocar a senha num lugar
    # e esquecer no outro. Host `postgres`, o nome do servico no compose -- nao localhost.
    printf 'DATABASE_URL=postgresql://%s:%s@postgres:5432/%s?schema=public\n' \
      "$POSTGRES_USER" "$POSTGRES_PASSWORD" "$POSTGRES_DB"
    printf 'JWT_SECRET=%s\n'         "$JWT_SECRET"
    printf 'ACCESS_TOKEN_TTL=%s\n'   "$ACCESS_TOKEN_TTL"
    printf 'REFRESH_TOKEN_DAYS=%s\n' "$REFRESH_TOKEN_DAYS"
    printf 'SYNC_PAGE_SIZE=%s\n'     "$SYNC_PAGE_SIZE"
    printf 'CORS_ORIGINS=%s\n'       "$CORS_ORIGINS"
  } > .env
  # Explicito alem do umask: cobre o caso de o arquivo ja existir de um deploy anterior.
  chmod 600 .env
  echo ".env escrito ($(wc -l < .env) linhas)"
}

# Espaco livre, em MB, no disco onde o Docker guarda imagens e cache de build.
espaco_livre_mb() {
  raiz=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker)
  [ -d "$raiz" ] || raiz=/
  df -Pm "$raiz" | awk 'NR==2 {print $4}'
}

# Um build precisa de folga para o `npm ci` (Prisma 7 + TypeScript passam de 1 GB
# descompactados) e para as camadas novas antes de as antigas sairem.
MIN_LIVRE_MB="${MIN_LIVRE_MB:-3072}"

# Libera disco antes do build. O que enchia a VM era o cache do BuildKit: cada deploy
# deixava uma camada nova de `npm ci`, e `docker image prune` nao toca nele. So mexe em
# cache de build e em imagens soltas -- nunca em volumes (o Postgres mora num) nem em
# imagens de containers de outros projetos da VM.
liberar_disco() {
  echo "Livre antes: $(espaco_livre_mb) MB"
  docker builder prune -f --filter 'until=72h' > /dev/null 2>&1 || true
  docker image prune -f > /dev/null 2>&1 || true

  if [ "$(espaco_livre_mb)" -lt "$MIN_LIVRE_MB" ]; then
    # Ainda apertado: vai o cache de build inteiro. O proximo build fica mais lento,
    # mas termina -- que e o que importa num deploy.
    echo "Menos de ${MIN_LIVRE_MB} MB livres; limpando todo o cache de build"
    docker builder prune -af > /dev/null 2>&1 || true
  fi

  livre=$(espaco_livre_mb)
  echo "Livre para o build: ${livre} MB"
  if [ "$livre" -lt "$MIN_LIVRE_MB" ]; then
    echo "ERRO: so ${livre} MB livres mesmo apos limpar o Docker (minimo ${MIN_LIVRE_MB} MB)."
    echo "      O que ocupa o disco:"
    df -h /
    docker system df || true
    echo "      Libere espaco na VM (logs, outros projetos) ou aumente o disco."
    exit 1
  fi
}

cmd_up() {
  echo "==> Build e subida dos containers"
  liberar_disco
  # Sem `down`: o compose recria so os servicos cujo build mudou, entao o Postgres nao
  # cai a cada deploy. As migrations rodam sozinhas na subida (prisma migrate deploy).
  docker compose up -d --build
  # A imagem anterior da API vira "solta" assim que a nova sobe: sai aqui.
  docker image prune -f > /dev/null 2>&1 || true
  echo "Livre depois do deploy: $(espaco_livre_mb) MB"
}

cmd_wait_health() {
  echo "==> Aguardando a API responder em localhost:${HOST_PORT}"
  for tentativa in $(seq 1 30); do
    if curl -fsS "http://localhost:${HOST_PORT}/health" > /dev/null 2>&1; then
      echo "API no ar apos ${tentativa} tentativa(s):"
      curl -fsS "http://localhost:${HOST_PORT}/health"
      echo
      return 0
    fi
    sleep 2
  done

  echo "ERRO: /health nao respondeu em 60s. Estado dos containers e logs:"
  docker compose ps
  docker compose logs --tail 80 api
  exit 1
}

case "${1:-}" in
  check-secrets) cmd_check_secrets ;;
  write-env)     cmd_check_secrets; cmd_write_env ;;
  up)            cmd_up ;;
  wait-health)   cmd_wait_health ;;
  all)           cmd_check_secrets; cmd_write_env; cmd_up; cmd_wait_health ;;
  *)
    echo "uso: deploy.sh {check-secrets | write-env | up | wait-health | all}"
    exit 2
    ;;
esac
