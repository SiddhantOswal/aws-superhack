# MSP Growth OS - Deployment & Operations Runbook

## Prerequisites

- AWS CLI configured with appropriate credentials
- Node.js 20+ installed
- PNPM package manager installed
- AWS CDK v2 installed (`npm install -g aws-cdk`)

## 1. Environment Setup

### Set AWS Profile and Region

```bash
# Set your AWS profile (if using multiple profiles)
export AWS_PROFILE=your-profile-name

# Set AWS region (most resources will be in this region)
export AWS_DEFAULT_REGION=ap-south-1

# Note: Bedrock is only available in us-east-1, so BEDROCK_REGION is set to us-east-1 in the stack environment
```

## 2. Deploy Infrastructure

### Bootstrap CDK (if first time in this region)

```bash
cd infra
cdk bootstrap
```

### Deploy All Stacks

```bash
cdk deploy --all
```

**Important:** Note the outputs from the deployment:
- `ApiUrl` - API Gateway endpoint URL
- `RawBucketNameOut` - S3 bucket for raw data and policies
- `ReportsBucketNameOut` - S3 bucket for reports and drafts
- `ActionsTableName` - DynamoDB table for actions ledger
- `ControlsTableName` - DynamoDB table for controls

Example output:
```
MspGrowthCoreStack.RawBucketName = mspgrowthcorestack-rawbucket-xxxxx
MspGrowthCoreStack.ReportsBucketName = mspgrowthcorestack-reportsbucket-xxxxx
MspGrowthAppStack.ApiUrl = https://xxxxx.execute-api.ap-south-1.amazonaws.com/prod/
```

## 3. Seed Sample Data

### Upload Sample Data to S3

```bash
# Replace <RAW_BUCKET_NAME> with the actual bucket name from deployment outputs
pnpm ts-node scripts/seed-s3.ts --bucket <RAW_BUCKET_NAME>
```

This will upload:
- Sample CSV files to `s3://<RAW_BUCKET>/raw/`
- Sample policy JSON to `s3://<RAW_BUCKET>/policies/`

## 4. Initialize Data Catalog

### Start Glue Crawler

**Important:** The Glue Crawler is not configured with auto-scheduling. You need to run it manually.

1. Go to AWS Glue Console
2. Navigate to "Crawlers" 
3. Find the crawler named `raw-data-crawler-<stack-name>`
4. Click "Run crawler once"

Wait for the crawler to complete (usually 2-5 minutes). This will:
- Discover CSV files in `s3://<RAW_BUCKET>/raw/`
- Create tables in the Glue Data Catalog
- Enable Athena queries on the data

### Create Athena Views

```bash
# Replace <API_URL> with the actual API Gateway URL from deployment
curl -X POST <API_URL>/admin/bootstrap
```

This creates the following views:
- `scope_usage_vw` - Aggregated billable hours by client/category/month
- `shelfware_vw` - License usage analysis with reclaimable seats
- `underbilling_vw` - Time vs invoice variance analysis

## 5. Trigger Policy Evaluation

### Option A: Wait for Scheduled Evaluation
The system is configured to evaluate policies every 5 minutes via EventBridge. Wait for the next scheduled run.

### Option B: Manual Trigger (Recommended for Testing)
1. Go to AWS Lambda Console
2. Find the `policy-evaluator` function
3. Click "Test" → "Create new test event"
4. Use any simple JSON payload: `{}`
5. Click "Test"

This will:
- Scan policy files in S3
- Query current month usage against thresholds
- Start Step Functions workflow for any breaches

## 6. Monitor and Approve Actions

### Check Pending Actions

```bash
# Replace <API_URL> with the actual API Gateway URL
curl <API_URL>/ledger
```

Look for actions with `status: "PENDING"`. Note the `action_id`.

### Approve an Action

```bash
# Replace <API_URL> and <ACTION_ID> with actual values
curl -X POST <API_URL>/actions/<ACTION_ID>/approve \
  -H "Content-Type: application/json" \
  -d '{"send_email": false}'
```

This will:
- Update the action status to "APPROVED"
- Unpause any paused controls for the category
- Generate email content (but won't send unless SES is verified)

## 7. Generate Reports

### Shelfware Report
```bash
curl <API_URL>/reports/shelfware
```

### Underbilling Report
```bash
curl <API_URL>/reports/underbilling
```

### QBR PDF Report
```bash
# Replace with actual client_id and period (YYYY-MM format)
curl -X POST <API_URL>/qbr/pdf \
  -H "Content-Type: application/json" \
  -d '{"client_id": "C001", "period": "2024-01"}'
```

The response will contain a `signedUrl` that's valid for 15 minutes. Open this URL to download the PDF.

## 8. Cost Controls

### Reduce EventBridge Frequency
To reduce costs, you can modify the EventBridge schedule:

1. Go to EventBridge Console
2. Find the rule `PolicyEvalSchedule`
3. Edit the schedule to run less frequently (e.g., hourly instead of every 5 minutes)
4. Or disable the rule entirely for testing

### Stop Glue Crawler Scheduling
The crawler is not auto-scheduled, but if you add scheduling later, remember to:
1. Go to Glue Console
2. Edit the crawler
3. Disable or modify the schedule

### Monitor Costs
- Use AWS Cost Explorer to monitor spending
- Set up billing alerts for unexpected costs
- Consider using AWS Free Tier limits for development

## 9. Email Configuration (Optional)

### SES Sandbox Mode
The system runs in SES sandbox mode by default, which means:
- Only verified sender addresses can send emails
- Only verified recipient addresses can receive emails
- Emails are generated but not sent unless properly verified

### To Enable Email Sending:
1. Go to SES Console
2. Verify sender email address (set in `EMAIL_FROM` environment variable)
3. Verify recipient email addresses
4. Request production access if needed

### Current Behavior:
- Email content is generated and returned in API responses
- Actual sending is skipped in sandbox mode
- Use `{"send_email": true}` in approve action calls to attempt sending

## 10. Troubleshooting

### Common Issues

**Athena Query Fails:**
- Ensure Glue Crawler has completed successfully
- Check that CSV files are properly formatted
- Verify Athena workgroup permissions

**Lambda Timeout:**
- Increase timeout in CDK stack if needed
- Check CloudWatch logs for specific errors

**S3 Access Denied:**
- Verify IAM roles have correct S3 permissions
- Check bucket policies and ACLs

**Step Functions Not Starting:**
- Verify EventBridge rule is enabled
- Check Lambda execution role has Step Functions permissions

### Useful Commands

```bash
# Check deployment status
cd infra && cdk list

# View CloudFormation stack outputs
aws cloudformation describe-stacks --stack-name MspGrowthCoreStack --query 'Stacks[0].Outputs'
aws cloudformation describe-stacks --stack-name MspGrowthAppStack --query 'Stacks[0].Outputs'

# View Lambda logs
aws logs tail /aws/lambda/<function-name> --follow

# Test API Gateway endpoints
curl -v <API_URL>/ledger
```

## 11. Cleanup

To remove all resources and avoid ongoing costs:

```bash
cd infra
cdk destroy --all
```

**Warning:** This will delete all data in S3 buckets and DynamoDB tables. Ensure you have backups if needed.
