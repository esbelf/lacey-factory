#!/usr/bin/env bash
# Deploys the web app to S3 + CloudFront and the API to Lambda.
# The AWS resources themselves (bucket, distribution, function) are created by
# Terraform in ../terraform-lacey-factory.
#
# Usage: scripts/deploy.sh staging|production
# Reads deploy/<env>.env for:
#   WEB_BUCKET, CLOUDFRONT_DISTRIBUTION_ID, LAMBDA_FUNCTION_NAME,
#   VITE_AUTH0_DOMAIN, VITE_AUTH0_CLIENT_ID, VITE_AUTH0_AUDIENCE
# Run migrations first if the schema changed:
#   DATABASE_URL=<neon url> npm run db:migrate -w api
set -euo pipefail

ENV="${1:?usage: scripts/deploy.sh staging|production}"
cd "$(dirname "$0")/.."
set -a; source "deploy/${ENV}.env"; set +a
: "${WEB_BUCKET:?}" "${CLOUDFRONT_DISTRIBUTION_ID:?}" "${LAMBDA_FUNCTION_NAME:?}"
: "${VITE_AUTH0_DOMAIN:?}" "${VITE_AUTH0_CLIENT_ID:?}" "${VITE_AUTH0_AUDIENCE:?}"
export VITE_DEV_AUTH=false

npm test
npm run build

echo "→ API: $LAMBDA_FUNCTION_NAME"
(cd api/dist && rm -f lambda.zip && zip -q lambda.zip lambda.mjs)
aws lambda update-function-code --function-name "$LAMBDA_FUNCTION_NAME" \
  --zip-file fileb://api/dist/lambda.zip --publish >/dev/null
aws lambda wait function-updated --function-name "$LAMBDA_FUNCTION_NAME"

echo "→ Web: s3://$WEB_BUCKET"
# Hashed assets cache forever; index.html must always be re-fetched.
aws s3 sync web/dist "s3://$WEB_BUCKET" --delete --exclude index.html \
  --cache-control "public,max-age=31536000,immutable"
aws s3 cp web/dist/index.html "s3://$WEB_BUCKET/index.html" --cache-control "no-cache"
aws cloudfront create-invalidation --distribution-id "$CLOUDFRONT_DISTRIBUTION_ID" --paths "/index.html" >/dev/null

echo "Deployed $ENV."
