# SuperHack - MSP Growth OS

**Smart SOWs & Growth Automation Platform** - Automatically detect scope breaches, draft change orders with AI, and generate business reports.

## Quick Start

```bash
# Bootstrap & Deploy
cd infra && npx cdk bootstrap && npx cdk deploy --all

# Seed S3 and run Glue crawler
pnpm ts-node scripts/seed-s3.ts --bucket <RAW_BUCKET_NAME>
# Go to AWS Glue Console → Crawlers → Run "raw-data-crawler-<stack-name>" once

# Initialize data catalog
curl -X POST <API_URL>/admin/bootstrap

# Test endpoints
curl <API_URL>/ledger
curl <API_URL>/reports/shelfware
curl <API_URL>/actions/{ACTION_ID}/approve
curl -X POST <API_URL>/qbr/pdf -d '{"client_id":"C001","period":"2024-01"}'

# Teardown
npx cdk destroy --all
```

## Key Endpoints

- `POST /admin/bootstrap` - Create Athena views
- `GET /ledger` - View actions ledger  
- `POST /actions/{id}/approve` - Approve change orders
- `POST /qbr/pdf` - Generate QBR reports
- `GET /reports/shelfware` - Shelfware analysis
- `GET /reports/underbilling` - Underbilling analysis
- `POST /policies/evaluate` - Manually trigger policy evaluation (local only)

## Testing

### Local Testing

Start the mock API server:
```bash
pnpm start:mock
```

Then test endpoints locally at `http://localhost:3000` using:
- **PowerShell:** `.\test-e2e.ps1`
- **Bash:** `./test-e2e.sh`
- **VS Code REST Client:** Use `docs/test.http`

See **[docs/E2E_TESTING.md](docs/E2E_TESTING.md)** for complete testing guide with all endpoints and examples.

---

*Built with AWS CDK v2, Lambda Node.js 20, and TypeScript.*
