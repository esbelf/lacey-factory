#!/bin/bash
# Runs inside LocalStack once it's ready: creates the supplier documents bucket.
set -euo pipefail
# LocalStack accepts any credentials; the aws CLI just needs some set.
export AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test
REGION="${AWS_DEFAULT_REGION:-us-east-2}"
BUCKET="${DOCUMENTS_BUCKET:-lacey-factory-documents-local}"

aws --endpoint-url http://localhost:4566 s3api head-bucket --bucket "$BUCKET" 2>/dev/null ||
  aws --endpoint-url http://localhost:4566 s3api create-bucket --bucket "$BUCKET" --region "$REGION" \
    --create-bucket-configuration LocationConstraint="$REGION"
echo "lacey-factory LocalStack init done (bucket $BUCKET)"
