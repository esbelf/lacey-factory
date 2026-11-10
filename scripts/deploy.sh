#!/usr/bin/env bash
# Deploys one environment: database migrations, the API (Lambda), the Temporal
# worker (ECS) and the web app (S3 + CloudFront). The AWS resources come from
# Terraform in ../terraform-lacey-factory.
#
# Usage: scripts/deploy.sh staging|production
# GitHub Actions (.github/workflows/deploy.yml) runs this with the settings as
# GitHub Environment variables (set by `make github-vars` in the terraform repo).
# To run it from a laptop, put the same settings in deploy/<env>.env (see
# deploy/example.env) and use an AWS profile for account 493424762573.
# SKIP_TESTS=1 skips `npm test` (CI runs the tests in an earlier step).
set -euo pipefail

ENV="${1:?usage: scripts/deploy.sh staging|production}"
cd "$(dirname "$0")/.."
if [[ -f "deploy/${ENV}.env" ]]; then set -a; source "deploy/${ENV}.env"; set +a; fi
: "${AWS_REGION:?}" "${WEB_BUCKET:?}" "${CLOUDFRONT_DISTRIBUTION_ID:?}" "${LAMBDA_FUNCTION_NAME:?}"
: "${ECR_REPOSITORY_URL:?}" "${ECS_CLUSTER:?}" "${ECS_SERVICE:?}" "${APP_SECRETS_ARN:?}"
: "${VITE_AUTH0_DOMAIN:?}" "${VITE_AUTH0_CLIENT_ID:?}" "${VITE_AUTH0_AUDIENCE:?}"
export AWS_REGION VITE_AUTH0_DOMAIN VITE_AUTH0_CLIENT_ID VITE_AUTH0_AUDIENCE
export VITE_DEV_AUTH=false
SHA="$(git rev-parse --short=12 HEAD)"

if [[ "${SKIP_TESTS:-}" != "1" ]]; then npm test; fi
npm run build

# Migrations run before the new code goes live, so each one must keep the
# currently deployed code working (add columns and tables; drop them later).
echo "→ Migrations"
DATABASE_URL="$(aws secretsmanager get-secret-value --secret-id "$APP_SECRETS_ARN" \
  --query SecretString --output text | jq -r '.DATABASE_URL // empty')"
if [[ -z "$DATABASE_URL" ]]; then
  echo "DATABASE_URL is empty in $APP_SECRETS_ARN. Fill it in (Secrets Manager) first." >&2
  exit 1
fi
DATABASE_URL="$DATABASE_URL" npm run db:migrate -w api

echo "→ API: $LAMBDA_FUNCTION_NAME"
(cd api/dist && rm -f lambda.zip && zip -q lambda.zip lambda.mjs lambda.mjs.map)
aws lambda update-function-code --function-name "$LAMBDA_FUNCTION_NAME" \
  --zip-file fileb://api/dist/lambda.zip >/dev/null
aws lambda wait function-updated --function-name "$LAMBDA_FUNCTION_NAME"

echo "→ Worker: $ECR_REPOSITORY_URL:$SHA"
aws ecr get-login-password | docker login --username AWS --password-stdin "${ECR_REPOSITORY_URL%%/*}"
docker buildx build --platform linux/amd64 -f Dockerfile.worker \
  -t "$ECR_REPOSITORY_URL:$SHA" -t "$ECR_REPOSITORY_URL:latest" --push .
aws ecs update-service --cluster "$ECS_CLUSTER" --service "$ECS_SERVICE" --force-new-deployment >/dev/null

echo "→ Web: s3://$WEB_BUCKET"
# Hashed assets cache forever; index.html must always be re-fetched.
aws s3 sync web/dist "s3://$WEB_BUCKET" --delete --exclude index.html \
  --cache-control "public,max-age=31536000,immutable"
aws s3 cp web/dist/index.html "s3://$WEB_BUCKET/index.html" --cache-control "no-cache"
aws cloudfront create-invalidation --distribution-id "$CLOUDFRONT_DISTRIBUTION_ID" --paths "/index.html" >/dev/null

echo "→ Waiting for the worker to come up"
aws ecs wait services-stable --cluster "$ECS_CLUSTER" --services "$ECS_SERVICE"

echo "Deployed $ENV ($SHA)."
