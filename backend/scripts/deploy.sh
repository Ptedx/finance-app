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

cmd_up() {
  echo "==> Build e subida dos containers"
  # Sem `down`: o compose recria so os servicos cujo build mudou, entao o Postgres nao
  # cai a cada deploy. As migrations rodam sozinhas na subida (prisma migrate deploy).
  docker compose up -d --build
  docker image prune -f > /dev/null 2>&1 || true
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
