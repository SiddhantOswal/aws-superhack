# End-to-End Testing Guide

This guide covers how to test all API endpoints both locally and against the deployed AWS infrastructure.

## Prerequisites

1. **For Local Testing:**
   - Node.js 20+ installed
   - pnpm installed
   - All dependencies installed: `pnpm install`

2. **For AWS Testing:**
   - AWS CLI configured
   - CDK stacks deployed
   - S3 data seeded
   - Glue crawler run
   - Athena views bootstrapped

## Running the Local Mock Server

Start the local server on `http://localhost:3000`:

```bash
pnpm start:mock
```

The server will output:
```
🚀 Mock API running on http://localhost:3000
```

## Available Endpoints

### Base URLs

- **Local:** `http://localhost:3000`
- **AWS (Production):** `https://<api-gateway-url>.execute-api.<region>.amazonaws.com/prod`

### Complete Endpoint List

#### 1. Initialize Data Catalog
**Endpoint:** `POST /admin/bootstrap`

**Description:** Creates Athena views for the data catalog (scope_usage_vw, shelfware_vw, underbilling_vw)

**Local Testing:**
```bash
curl -X POST http://localhost:3000/admin/bootstrap \
  -H "Content-Type: application/json"
```

**AWS Testing:**
```bash
curl -X POST <API_URL>/admin/bootstrap \
  -H "Content-Type: application/json"
```

**Expected Response:**
```json
{
  "status": "ok"
}
```

**Note:** This endpoint is only functional on AWS (requires Athena). Local version may return an error or mock response.

---

#### 2. Get Actions Ledger
**Endpoint:** `GET /ledger`

**Description:** Returns the last 50 actions across all clients, or filtered by client_id

**Query Parameters:**
- `client_id` (optional): Filter actions for a specific client

**Local Testing:**
```bash
# Get all actions
curl http://localhost:3000/ledger

# Get actions for specific client
curl "http://localhost:3000/ledger?client_id=C001"
```

**AWS Testing:**
```bash
# Get all actions
curl <API_URL>/ledger

# Get actions for specific client
curl "<API_URL>/ledger?client_id=C001"
```

**Expected Response:**
```json
{
  "items": [
    {
      "action_id": "12345",
      "client_id": "C001",
      "category": "how-to",
      "status": "PENDING",
      "created_at": "2025-01-15T10:30:00Z",
      "est_saving_inr": 10000
    }
  ]
}
```

---

#### 3. Approve Action
**Endpoint:** `POST /actions/{action_id}/approve`

**Description:** Approves a pending action and optionally sends an email

**Path Parameters:**
- `action_id`: The ID of the action to approve

**Request Body:**
```json
{
  "est_saving_inr": 50000,    // Optional: Override estimated savings
  "send_email": false,         // Optional: Whether to send email
  "email_to": "customer@example.com"  // Optional: Email recipient
}
```

**Local Testing:**
```bash
# Basic approval
curl -X POST http://localhost:3000/actions/12345/approve \
  -H "Content-Type: application/json" \
  -d '{}'

# With custom savings
curl -X POST http://localhost:3000/actions/12345/approve \
  -H "Content-Type: application/json" \
  -d '{"est_saving_inr": 50000, "send_email": false}'
```

**AWS Testing:**
```bash
# Basic approval
curl -X POST <API_URL>/actions/<ACTION_ID>/approve \
  -H "Content-Type: application/json" \
  -d '{}'

# With email (requires SES verification)
curl -X POST <API_URL>/actions/<ACTION_ID>/approve \
  -H "Content-Type: application/json" \
  -d '{"est_saving_inr": 75000, "send_email": true, "email_to": "customer@example.com"}'
```

**Expected Response:**
```json
{
  "status": "APPROVED",
  "action_id": "12345",
  "email": {
    "subject": "Action required: Approve change order (how-to)",
    "body": "Dear customer,\n\nWe detected 4h over the contracted 10h..."
  }
}
```

**Note:** To get a valid action_id, first call `/ledger` and find an action with `status: "PENDING"`.

---

#### 4. Get Shelfware Report
**Endpoint:** `GET /reports/shelfware`

**Description:** Returns top 20 reclaimable seats by annual saving potential

**Local Testing:**
```bash
curl http://localhost:3000/reports/shelfware
```

**AWS Testing:**
```bash
curl <API_URL>/reports/shelfware
```

**Expected Response:**
```json
{
  "items": [
    {
      "client_id": "C001",
      "app": "Office365",
      "reclaimable_seats": "45",
      "annual_saving_inr": "648000"
    }
  ]
}
```

---

#### 5. Get Underbilling Report
**Endpoint:** `GET /reports/underbilling`

**Description:** Returns invoice variance analysis with suggested addendums

**Local Testing:**
```bash
curl http://localhost:3000/reports/underbilling
```

**AWS Testing:**
```bash
curl <API_URL>/reports/underbilling
```

**Expected Response:**
```json
{
  "items": [
    {
      "client_id": "C001",
      "period": "2024-01",
      "hours": "120",
      "expected_inr": "264000",
      "billed_inr": "200000",
      "delta_inr": "64000",
      "suggestion": "Addendum: Invoice delta INR 64000 for 2024-01"
    }
  ]
}
```

---

#### 6. Generate QBR PDF Report
**Endpoint:** `POST /qbr/pdf`

**Description:** Generates a QBR (Quarterly Business Review) PDF report for a specific client and period

**Request Body:**
```json
{
  "client_id": "C001",
  "period": "2025-09"
}
```

**Local Testing:**
```bash
curl -X POST http://localhost:3000/qbr/pdf \
  -H "Content-Type: application/json" \
  -d '{"client_id": "C001", "period": "2025-09"}'
```

**AWS Testing:**
```bash
curl -X POST <API_URL>/qbr/pdf \
  -H "Content-Type: application/json" \
  -d '{"client_id": "C001", "period": "2025-09"}'
```

**Expected Response:**
```json
{
  "signedUrl": "https://s3.amazonaws.com/bucket/pdf/C001-2025-09.pdf?X-Amz-Algorithm=..."
}
```

**Note:** The signed URL is valid for 15 minutes. Open it in a browser to download the PDF.

---

#### 7. Evaluate Policies (Local Only)
**Endpoint:** `POST /policies/evaluate`

**Description:** Manually trigger policy evaluation (this runs automatically on AWS via EventBridge)

**Local Testing:**
```bash
curl -X POST http://localhost:3000/policies/evaluate \
  -H "Content-Type: application/json" \
  -d '{}'
```

**AWS Testing:**
This endpoint is not exposed via API Gateway. Instead:
1. Go to AWS Lambda Console
2. Find the `policy-evaluator` function
3. Click "Test" → "Create new test event"
4. Use payload: `{}`
5. Click "Test"

**Expected Response:**
```json
{
  "breaches_started": 2
}
```

---

## Complete Test Script

Save this as `test-e2e.sh` (or `test-e2e.ps1` for PowerShell on Windows):

### Bash Script (test-e2e.sh)
```bash
#!/bin/bash

# Configuration
LOCAL_URL="http://localhost:3000"
# AWS_URL="https://your-api-gateway-url.execute-api.ap-south-1.amazonaws.com/prod"

# Uncomment to test AWS instead
# BASE_URL="$AWS_URL"
BASE_URL="$LOCAL_URL"

echo "🧪 Testing Endpoints against: $BASE_URL"
echo "=========================================="

# Test 1: Get Ledger
echo ""
echo "1. Testing GET /ledger"
curl -s "$BASE_URL/ledger" | jq '.' || echo "Failed"

# Test 2: Shelfware Report
echo ""
echo "2. Testing GET /reports/shelfware"
curl -s "$BASE_URL/reports/shelfware" | jq '.' || echo "Failed"

# Test 3: Underbilling Report
echo ""
echo "3. Testing GET /reports/underbilling"
curl -s "$BASE_URL/reports/underbilling" | jq '.' || echo "Failed"

# Test 4: Get Action ID from ledger
echo ""
echo "4. Getting action_id from ledger..."
ACTION_ID=$(curl -s "$BASE_URL/ledger" | jq -r '.items[0].action_id // "12345"')
echo "Using action_id: $ACTION_ID"

# Test 5: Approve Action
echo ""
echo "5. Testing POST /actions/$ACTION_ID/approve"
curl -s -X POST "$BASE_URL/actions/$ACTION_ID/approve" \
  -H "Content-Type: application/json" \
  -d '{}' | jq '.' || echo "Failed"

# Test 6: QBR PDF
echo ""
echo "6. Testing POST /qbr/pdf"
curl -s -X POST "$BASE_URL/qbr/pdf" \
  -H "Content-Type: application/json" \
  -d '{"client_id": "C001", "period": "2025-09"}' | jq '.' || echo "Failed"

# Test 7: Policies Evaluate (Local only)
if [[ "$BASE_URL" == "$LOCAL_URL" ]]; then
  echo ""
  echo "7. Testing POST /policies/evaluate (Local only)"
  curl -s -X POST "$BASE_URL/policies/evaluate" \
    -H "Content-Type: application/json" \
    -d '{}' | jq '.' || echo "Failed"
fi

# Test 8: Bootstrap (AWS only - will fail locally)
if [[ "$BASE_URL" != "$LOCAL_URL" ]]; then
  echo ""
  echo "8. Testing POST /admin/bootstrap (AWS only)"
  curl -s -X POST "$BASE_URL/admin/bootstrap" \
    -H "Content-Type: application/json" | jq '.' || echo "Failed"
fi

echo ""
echo "✅ Testing complete!"
```

### PowerShell Script (test-e2e.ps1)
```powershell
# Configuration
$LOCAL_URL = "http://localhost:3000"
# $AWS_URL = "https://your-api-gateway-url.execute-api.ap-south-1.amazonaws.com/prod"

# Uncomment to test AWS instead
# $BASE_URL = $AWS_URL
$BASE_URL = $LOCAL_URL

Write-Host "🧪 Testing Endpoints against: $BASE_URL" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan

# Test 1: Get Ledger
Write-Host ""
Write-Host "1. Testing GET /ledger" -ForegroundColor Yellow
try {
    $response = Invoke-RestMethod -Uri "$BASE_URL/ledger" -Method Get
    $response | ConvertTo-Json -Depth 10
} catch {
    Write-Host "Failed: $_" -ForegroundColor Red
}

# Test 2: Shelfware Report
Write-Host ""
Write-Host "2. Testing GET /reports/shelfware" -ForegroundColor Yellow
try {
    $response = Invoke-RestMethod -Uri "$BASE_URL/reports/shelfware" -Method Get
    $response | ConvertTo-Json -Depth 10
} catch {
    Write-Host "Failed: $_" -ForegroundColor Red
}

# Test 3: Underbilling Report
Write-Host ""
Write-Host "3. Testing GET /reports/underbilling" -ForegroundColor Yellow
try {
    $response = Invoke-RestMethod -Uri "$BASE_URL/reports/underbilling" -Method Get
    $response | ConvertTo-Json -Depth 10
} catch {
    Write-Host "Failed: $_" -ForegroundColor Red
}

# Test 4: Get Action ID from ledger
Write-Host ""
Write-Host "4. Getting action_id from ledger..." -ForegroundColor Yellow
try {
    $ledger = Invoke-RestMethod -Uri "$BASE_URL/ledger" -Method Get
    $ACTION_ID = if ($ledger.items.Count -gt 0) { $ledger.items[0].action_id } else { "12345" }
    Write-Host "Using action_id: $ACTION_ID" -ForegroundColor Green
} catch {
    $ACTION_ID = "12345"
    Write-Host "Using default action_id: $ACTION_ID" -ForegroundColor Yellow
}

# Test 5: Approve Action
Write-Host ""
Write-Host "5. Testing POST /actions/$ACTION_ID/approve" -ForegroundColor Yellow
try {
    $body = @{} | ConvertTo-Json
    $response = Invoke-RestMethod -Uri "$BASE_URL/actions/$ACTION_ID/approve" -Method Post -Body $body -ContentType "application/json"
    $response | ConvertTo-Json -Depth 10
} catch {
    Write-Host "Failed: $_" -ForegroundColor Red
}

# Test 6: QBR PDF
Write-Host ""
Write-Host "6. Testing POST /qbr/pdf" -ForegroundColor Yellow
try {
    $body = @{
        client_id = "C001"
        period = "2025-09"
    } | ConvertTo-Json
    $response = Invoke-RestMethod -Uri "$BASE_URL/qbr/pdf" -Method Post -Body $body -ContentType "application/json"
    $response | ConvertTo-Json -Depth 10
} catch {
    Write-Host "Failed: $_" -ForegroundColor Red
}

# Test 7: Policies Evaluate (Local only)
if ($BASE_URL -eq $LOCAL_URL) {
    Write-Host ""
    Write-Host "7. Testing POST /policies/evaluate (Local only)" -ForegroundColor Yellow
    try {
        $body = @{} | ConvertTo-Json
        $response = Invoke-RestMethod -Uri "$BASE_URL/policies/evaluate" -Method Post -Body $body -ContentType "application/json"
        $response | ConvertTo-Json -Depth 10
    } catch {
        Write-Host "Failed: $_" -ForegroundColor Red
    }
}

# Test 8: Bootstrap (AWS only)
if ($BASE_URL -ne $LOCAL_URL) {
    Write-Host ""
    Write-Host "8. Testing POST /admin/bootstrap (AWS only)" -ForegroundColor Yellow
    try {
        $body = @{} | ConvertTo-Json
        $response = Invoke-RestMethod -Uri "$BASE_URL/admin/bootstrap" -Method Post -Body $body -ContentType "application/json"
        $response | ConvertTo-Json -Depth 10
    } catch {
        Write-Host "Failed: $_" -ForegroundColor Red
    }
}

Write-Host ""
Write-Host "✅ Testing complete!" -ForegroundColor Green
```

## Using the Test Scripts

### On Linux/Mac:
```bash
chmod +x test-e2e.sh
./test-e2e.sh
```

### On Windows (PowerShell):
```powershell
.\test-e2e.ps1
```

## Testing Workflow

### Local Testing Workflow

1. **Start the local server:**
   ```bash
   pnpm start:mock
   ```

2. **In another terminal, run the test script:**
   ```bash
   ./test-e2e.sh  # or .\test-e2e.ps1 on Windows
   ```

3. **Or test individual endpoints manually** using the curl/Invoke-RestMethod commands above.

### AWS Testing Workflow

1. **Deploy infrastructure:**
   ```bash
   cd infra && npx cdk deploy --all
   ```

2. **Seed S3 data:**
   ```bash
   pnpm ts-node scripts/seed-s3.ts --bucket <RAW_BUCKET_NAME>
   ```

3. **Run Glue crawler** (via AWS Console)

4. **Bootstrap Athena views:**
   ```bash
   curl -X POST <API_URL>/admin/bootstrap
   ```

5. **Update the test script** with your API URL and run it:
   ```bash
   # Edit test-e2e.sh to use AWS_URL instead of LOCAL_URL
   ./test-e2e.sh
   ```

## Expected Results

- ✅ All endpoints should return valid JSON responses
- ✅ Shelfware and Underbilling reports should return arrays of items
- ✅ Ledger should return actions (may be empty initially)
- ✅ Approve action should change status to "APPROVED"
- ✅ QBR PDF should return a signed URL
- ⚠️ Bootstrap endpoint will only work on AWS (requires Athena)

## Troubleshooting

### Local Server Issues
- Ensure port 3000 is not in use
- Check that mock-data files exist in `mock-data/` directory
- Verify all dependencies are installed: `pnpm install`

### AWS Issues
- Verify API Gateway URL is correct
- Check CloudWatch logs for Lambda errors
- Ensure IAM permissions are correct
- Verify S3 data is seeded and Glue crawler has run

### Common Errors
- **404 Not Found:** Check endpoint URL and path
- **500 Internal Server Error:** Check CloudWatch logs or local server console
- **Timeout:** Increase Lambda timeout or check Athena query performance
- **Access Denied:** Verify IAM roles and S3 bucket policies

## Next Steps

After validating all endpoints:
1. Check the response formats match expected schemas
2. Verify business logic (e.g., shelfware calculations)
3. Test error handling with invalid inputs
4. Test edge cases (empty results, missing data, etc.)
